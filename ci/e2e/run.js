#!/usr/bin/env node
// End-to-end test: imports workflow.json into a throwaway n8n and talks to the bot the way Telegram would.
//
//   node ci/e2e/run.js            (needs Docker and openssl; nothing else is installed or kept)
//
// Everything runs on an internal Docker network with no route to the internet. Inside it the names
// api.everhour.com and api.telegram.org resolve to mock.js, so the workflow is tested with its real URLs
// and can never reach the real services. All credentials are made up.
//
// Env: N8N_IMAGE (default below), E2E_KEEP=1 leaves the containers running for debugging,
//      E2E_LOG_DIR = where n8n and mock logs are written (default ci/e2e/logs).
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const IMAGE = process.env.N8N_IMAGE || 'n8nio/n8n:2.49.6';
const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = process.env.E2E_LOG_DIR || path.join(__dirname, 'logs');
const NET = 'eh-e2e-net';
const MOCK = 'eh-e2e-mock';
const N8N = 'eh-e2e-n8n';
const CHAT = 111;
const EVERHOUR_KEY = 'test-everhour-key';
const TELEGRAM_TOKEN = '123456:TEST-TOKEN';
const BOT_ID = 'ci-bot';

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (e) {
    // keep the command's own output: execFileSync alone reports only "Command failed"
    e.message = `${e.message}\n${e.stdout || ''}${e.stderr || ''}`.trim();
    throw e;
  }
};
const docker = (...args) => sh('docker', args);
const quiet = (...args) => { try { docker(...args); } catch (e) { /* not there */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = (name) => docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name).trim();
// n8n CLI inside the running container. It shares the database with the server, so a command can
// lose a race with it; these commands are safe to repeat, so retry and say so in the log.
const n8nCli = (...args) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return docker('exec', N8N, 'n8n', ...args);
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`warn n8n ${args.join(' ')} failed (attempt ${attempt}), retrying:\n${String(e.message).split('\n').slice(-6).join('\n')}`);
      execFileSync('sleep', ['3']);
    }
  }
};
const log = (msg) => console.log(msg);

let mockUrl;
let n8nUrl;
let updateId = 1000;
let secret = '';
let hookPath = '';

const mockState = async () => (await fetch(`${mockUrl}/state`)).json();
const callsAfter = async (seq) => (await mockState()).calls.filter((c) => c.seq > seq);
const lastSeq = async () => (await mockState()).calls.length;
const sent = (calls) => calls.filter((c) => c.api === 'telegram' && c.path === '/sendMessage').map((c) => c.body);

async function waitFor(what, fn, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => { last = e; return null; });
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
// Wait until the bot has sent `count` messages after `seq`, then make sure no extra ones follow.
async function messagesAfter(seq, count, what) {
  if (count > 0) await waitFor(`${count} Telegram message(s): ${what}`, async () => sent(await callsAfter(seq)).length >= count);
  await sleep(count > 0 ? 1200 : 4000);
  const calls = await callsAfter(seq);
  const msgs = sent(calls);
  assert.strictEqual(msgs.length, count, `${what}: expected ${count} message(s), got ${msgs.length}: ${JSON.stringify(msgs.map((m) => m.text))}`);
  return { msgs, calls };
}
const buttons = (msg) => {
  const markup = typeof msg.reply_markup === 'string' ? JSON.parse(msg.reply_markup) : (msg.reply_markup || {});
  return (markup.inline_keyboard || []).flat().map((b) => ({ text: b.text, data: b.callback_data }));
};

async function telegram(update, { token = secret } = {}) {
  const res = await fetch(`${n8nUrl}${hookPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': token },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  });
  return res.status;
}
const say = (text, extra = {}, chat = CHAT) => telegram({
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false, first_name: 'Tester' }, text, ...extra },
});
const click = (data) => telegram({
  callback_query: { id: `cb${updateId}`, from: { id: CHAT, is_bot: false, first_name: 'Tester' }, data, message: { message_id: 1, chat: { id: CHAT, type: 'private' } } },
});
// Runs the scheduled branch at a chosen time and returns once the execution has finished.
async function runSchedule(testNow) {
  const res = await fetch(`${n8nUrl}/webhook/ci-run-schedule`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test_now: testNow }),
  });
  const body = await res.text();
  // n8n answers 500 "No item to return was found" when the run finished and had nothing to send; a failed run says "Error in workflow"
  const nothingToDo = res.status === 500 && /No item to return was found/.test(body);
  assert.ok(res.status === 200 || nothingToDo, `scheduled run at ${testNow} failed: HTTP ${res.status} ${body.slice(0, 500)}`);
}

async function waitForWebhook(prefix) {
  const hook = await waitFor(`n8n to register the Telegram webhook (${prefix || 'any'})`, async () => {
    const w = (await mockState()).webhook;
    return w && (!prefix || String(w.secret_token).startsWith(prefix)) ? w : null;
  }, 90000);
  secret = hook.secret_token;
  hookPath = new URL(hook.url).pathname;
  await waitFor('the Telegram webhook to answer', async () => (await telegram({}, { token: 'wrong' })) === 403, 30000);
}

// The copy that gets tested after "installation": the user's chat id in Config, plus a test-only entry
// (webhook -> clock -> Config) that stands in for the Schedule trigger so a run can be given a date.
function configuredWorkflow(pristine) {
  const wf = JSON.parse(JSON.stringify(pristine));
  wf.id = BOT_ID;
  const config = wf.nodes.find((n) => n.name === 'Config');
  config.parameters.assignments.assignments.find((a) => a.name === 'TELEGRAM_CHAT_ID').value = String(CHAT);
  wf.nodes.push(
    {
      id: 'ci1', name: 'CI: run schedule', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-240, -200], webhookId: 'ci-run-schedule',
      parameters: { httpMethod: 'POST', path: 'ci-run-schedule', responseMode: 'lastNode', options: {} },
    },
    {
      id: 'ci2', name: 'CI: clock', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, -200],
      parameters: { mode: 'manual', assignments: { assignments: [{ id: 'ci3', name: 'test_now', type: 'string', value: '={{ $json.body.test_now }}' }] }, includeOtherFields: false, options: {} },
    },
  );
  wf.connections['CI: run schedule'] = { main: [[{ node: 'CI: clock', type: 'main', index: 0 }]] };
  wf.connections['CI: clock'] = { main: [[{ node: 'Config', type: 'main', index: 0 }]] };
  return wf;
}

const warsawDate = (offsetDays = 0) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date(Date.now() + offsetDays * 86400000));

function cleanup() {
  quiet('rm', '-f', N8N, MOCK);
  quiet('network', 'rm', NET);
}
// For debugging a failed run: the n8n log and every request the workflow made to the mock
async function saveLogs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'n8n.log'), sh('sh', ['-c', `docker logs ${N8N} 2>&1`], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    fs.writeFileSync(path.join(LOG_DIR, 'n8n.log'), `no n8n log: ${e.message}`);
  }
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'mock-calls.json'), JSON.stringify(await mockState(), null, 2));
  } catch (e) { /* mock never started */ }
}

async function main() {
  const pristinePath = path.join(ROOT, 'workflow.json');
  const pristine = JSON.parse(fs.readFileSync(pristinePath, 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-e2e-'));
  const certs = path.join(tmp, 'certs');
  const input = path.join(tmp, 'in');
  fs.mkdirSync(certs);
  fs.mkdirSync(input);

  log(`n8n image: ${IMAGE}`);
  cleanup();

  // Throwaway CA and a certificate for the two API host names
  const ssl = (...a) => sh('openssl', a);
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=e2e test CA', '-keyout', path.join(certs, 'ca.key'), '-out', path.join(certs, 'ca.crt'));
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.everhour.com', '-keyout', path.join(certs, 'server.key'), '-out', path.join(certs, 'server.csr'));
  fs.writeFileSync(path.join(certs, 'san.cnf'), 'subjectAltName=DNS:api.everhour.com,DNS:api.telegram.org\n');
  ssl('x509', '-req', '-in', path.join(certs, 'server.csr'), '-CA', path.join(certs, 'ca.crt'), '-CAkey', path.join(certs, 'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', path.join(certs, 'san.cnf'), '-out', path.join(certs, 'server.crt'));

  fs.writeFileSync(path.join(input, 'credentials.json'), JSON.stringify([
    { id: 'ci-everhour', name: 'Everhour API key', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: EVERHOUR_KEY } },
    { id: 'ci-telegram', name: 'Telegram: Everhour bot', type: 'telegramApi', data: { accessToken: TELEGRAM_TOKEN, baseUrl: 'https://api.telegram.org' } },
  ]));
  fs.copyFileSync(pristinePath, path.join(input, 'bot.json')); // byte for byte what users import
  fs.copyFileSync(path.join(__dirname, 'tables.workflow.json'), path.join(input, 'tables.json'));
  fs.writeFileSync(path.join(input, 'bot.configured.json'), JSON.stringify(configuredWorkflow(pristine)));
  sh('chmod', ['-R', 'a+rX', tmp]);

  docker('network', 'create', '--internal', NET);
  docker('run', '-d', '--name', MOCK, '--network', NET, '--network-alias', 'api.everhour.com', '--network-alias', 'api.telegram.org',
    '-e', `MOCK_EVERHOUR_KEY=${EVERHOUR_KEY}`, '-e', `MOCK_TELEGRAM_TOKEN=${TELEGRAM_TOKEN}`,
    '-v', `${certs}:/certs:ro`, '-v', `${path.join(__dirname, 'mock.js')}:/mock.js:ro`, '--entrypoint', 'node', IMAGE, '/mock.js');
  docker('run', '-d', '--name', N8N, '--network', NET,
    '-v', `${input}:/in:ro`, '-v', `${path.join(certs, 'ca.crt')}:/certs/ca.crt:ro`,
    '-e', 'NODE_EXTRA_CA_CERTS=/certs/ca.crt', '-e', 'N8N_LISTEN_ADDRESS=0.0.0.0', '-e', 'N8N_WEBHOOK_URL=http://n8n.test:5678/', '-e', 'WEBHOOK_URL=http://n8n.test:5678/',
    '-e', 'N8N_ENCRYPTION_KEY=e2e-only', '-e', 'GENERIC_TIMEZONE=Europe/Warsaw', '-e', 'TZ=Europe/Warsaw',
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false', '-e', 'N8N_TEMPLATES_ENABLED=false',
    IMAGE);
  mockUrl = `http://${ip(MOCK)}:8080`;
  n8nUrl = `http://${ip(N8N)}:5678`;
  await waitFor('the mock to start', async () => (await fetch(`${mockUrl}/health`)).ok, 30000);
  await waitFor('n8n to start', async () => (await fetch(`${n8nUrl}/healthz/readiness`)).ok, 180000);
  log('n8n is up');

  // ---------- Phase A: a fresh install of the committed workflow.json, credentials found by name
  n8nCli('import:credentials', '--input=/in/credentials.json');
  n8nCli('import:workflow', '--input=/in/bot.json');
  n8nCli('import:workflow', '--input=/in/tables.json');
  const listed = n8nCli('list:workflow').split('\n').map((l) => l.trim().split('|')).filter((p) => p.length === 2);
  const fresh = listed.find(([, name]) => name === pristine.name);
  assert.ok(fresh, `imported workflow "${pristine.name}" not found in: ${JSON.stringify(listed)}`);
  n8nCli('publish:workflow', '--id=ci-tables');
  n8nCli('publish:workflow', `--id=${fresh[0]}`);
  await waitForWebhook(`${fresh[0]}_`);
  const tables = await waitFor('the data tables to be created', async () => {
    const res = await fetch(`${n8nUrl}/webhook/ci-create-tables`, { method: 'POST' });
    return res.ok ? res.text() : null;
  }, 60000);
  assert.match(tables, /invoice_reminders/);
  log('ok   import: workflow.json imports and publishes, credentials are matched by name, Telegram webhook registered');

  let seq = await lastSeq();
  assert.strictEqual(await say('/start'), 200);
  let r = await messagesAfter(seq, 1, 'fresh install /start');
  assert.strictEqual(String(r.msgs[0].chat_id), String(CHAT));
  assert.match(r.msgs[0].text, /^Bot działa\. Twój chat_id: <code>111<\/code>/);
  log('ok   fresh install: /start answers with the chat_id');

  // ---------- Phase B: the installed bot (chat id set in Config)
  n8nCli('unpublish:workflow', `--id=${fresh[0]}`);
  // The server applies the unpublish a moment later; publishing the next copy before that collides on the webhook path
  await waitFor('n8n to remove the Telegram webhook of the unpublished workflow', async () => (await mockState()).webhook === null, 60000);
  n8nCli('import:workflow', '--input=/in/bot.configured.json');
  n8nCli('publish:workflow', `--id=${BOT_ID}`);
  await waitForWebhook(`${BOT_ID}_`);

  const today = warsawDate(0);
  await fetch(`${mockUrl}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      time: [
        { task: 'ev:100', date: '2026-10-27', time: 8 * 3600 },
        { task: 'ev:100', date: '2026-10-28', time: 8 * 3600 },
        { task: 'ev:100', date: warsawDate(-3), time: 8 * 3600 },
        { task: 'ev:200', date: warsawDate(-4), time: 3600 },
      ],
    }),
  });

  seq = await lastSeq();
  assert.strictEqual(await say('8', {}, 999), 200);
  await messagesAfter(seq, 0, 'message from another chat');
  log('ok   a chat other than TELEGRAM_CHAT_ID gets no answer');

  seq = await lastSeq();
  await say('/help');
  r = await messagesAfter(seq, 1, '/help');
  assert.match(r.msgs[0].text, /^Pilnuję godzin w Everhourze/);
  log('ok   /help');

  // Scheduled run on Fri 30.10.2026 09:30: Thursday has no hours, and it is the invoice due day
  seq = await lastSeq();
  await runSchedule('2026-10-30T09:30:00');
  r = await messagesAfter(seq, 2, 'scheduled run, Friday morning');
  const reminder = r.msgs.find((m) => /Brak godzin/.test(m.text));
  const invoice = r.msgs.find((m) => /faktur/.test(m.text));
  assert.ok(reminder && invoice, JSON.stringify(r.msgs.map((m) => m.text)));
  assert.match(reminder.text, /^Brak godzin w Everhourze za <b>czwartek 29\.10<\/b>\.\nOdpisz, ile wpisać .*zaloguję na „Development”/);
  assert.deepStrictEqual(buttons(reminder), [{ text: 'Wolne', data: 'off|2026-10-29' }]);
  assert.match(invoice.text, /^Dziś \(<b>piątek 30\.10<\/b>\) ostatni dzień roboczy października: wystaw fakturę za październik\./);
  assert.deepStrictEqual(buttons(invoice), [{ text: 'Raport: październik', data: 'rep|2026-10' }, { text: 'Wystawiona', data: 'inv|2026-10' }]);
  const timeCall = r.calls.find((c) => c.api === 'everhour' && c.path === '/users/1001/time');
  assert.deepStrictEqual(timeCall.query, { from: '2026-09-24', to: '2026-10-29', limit: '1000' });
  log('ok   scheduled run: reminder with "Wolne" for the day without hours + invoice reminder on the due day');

  seq = await lastSeq();
  await runSchedule('2026-10-30T14:00:00');
  r = await messagesAfter(seq, 2, 'scheduled run, Friday afternoon');
  assert.ok(r.msgs.every((m) => /^Przypominam\. /.test(m.text)), JSON.stringify(r.msgs.map((m) => m.text)));
  log('ok   scheduled run: still unanswered at 14:00 -> both reminders repeat');

  seq = await lastSeq();
  await click('off|2026-10-29');
  r = await messagesAfter(seq, 1, '"Wolne" button');
  assert.strictEqual(r.msgs[0].text, 'OK, <b>czwartek 29.10</b> to dzień wolny. Nie przypominam.');
  assert.ok(r.calls.some((c) => c.path === '/answerCallbackQuery' && c.body.callback_query_id), 'button press was not acknowledged');
  seq = await lastSeq();
  await click('inv|2026-10');
  r = await messagesAfter(seq, 1, '"Wystawiona" button');
  assert.match(r.msgs[0].text, /^Odnotowane: faktura za październik wystawiona\./);
  log('ok   buttons "Wolne" and "Wystawiona"');

  seq = await lastSeq();
  await runSchedule('2026-10-30T21:30:00');
  r = await messagesAfter(seq, 0, 'scheduled run after both were answered');
  assert.ok(r.calls.some((c) => c.api === 'everhour'), 'the evening run did not query Everhour');
  log('ok   scheduled run: answers were stored in both data tables -> no more reminders');

  seq = await lastSeq();
  await click('rep|2026-10');
  r = await messagesAfter(seq, 1, 'report button');
  assert.match(r.msgs[0].text, /^<b>Raport Everhour: październik 2026<\/b> \(1\.10–31\.10\)\nŁącznie: <b>16 h<\/b>/);
  assert.match(r.msgs[0].text, /• Acme: 16 h/);
  const dash = r.calls.find((c) => c.api === 'everhour' && c.path === '/dashboards/users');
  assert.deepStrictEqual(dash.query, { 'date.gte': '2026-10-01', 'date.lte': '2026-10-31', memberId: '1001' });
  log('ok   monthly report from the Everhour dashboards');

  // Logging hours: no open reminder, so the bot asks which day
  seq = await lastSeq();
  await say('7,5');
  r = await messagesAfter(seq, 1, 'hours without a reminder');
  assert.strictEqual(r.msgs[0].text, 'Za który dzień wpisać 7,5 h?');
  const [todayBtn, yesterdayBtn, cancelBtn] = buttons(r.msgs[0]);
  assert.strictEqual(todayBtn.data, `log|${today}|27000`);
  assert.match(yesterdayBtn.data, /^log\|\d{4}-\d{2}-\d{2}\|27000$/);
  assert.strictEqual(cancelBtn.data, 'cancel');
  seq = await lastSeq();
  await click(todayBtn.data);
  r = await messagesAfter(seq, 1, 'log 7,5 h for today');
  assert.match(r.msgs[0].text, /^Zapisane: <b>7,5 h<\/b> za .*, task „Development”\.$/);
  const post = r.calls.find((c) => c.api === 'everhour' && c.method === 'POST');
  assert.deepStrictEqual([post.path, post.body], ['/time', { task: 'ev:100', user: 1001, date: today, time: 27000 }]);
  log('ok   "7,5" -> asks which day -> creates the Everhour entry on the main task');

  seq = await lastSeq();
  await say('8 deploy i review', { reply_to_message: { message_id: 5, text: `Brak godzin\n${today}` } });
  r = await messagesAfter(seq, 1, 'correct today to 8 h');
  assert.match(r.msgs[0].text, /^Zapisane: <b>8 h<\/b> za .* \(było 7,5 h\), task „Development”\.$/);
  const put = r.calls.find((c) => c.api === 'everhour' && c.method === 'PUT');
  assert.match(put.path, /^\/time\/\d+$/);
  assert.deepStrictEqual(put.body, { time: 28800, comment: 'deploy i review' });
  const stored = (await mockState()).time.filter((t) => t.date === today);
  assert.deepStrictEqual(stored.map((t) => [t.time, t.comment, t.task.id]), [[28800, 'deploy i review', 'ev:100']]);
  log('ok   reply "8 deploy i review" -> updates the same entry, comment included');

  seq = await lastSeq();
  await say('/status');
  r = await messagesAfter(seq, 1, '/status');
  assert.match(r.msgs[0].text, /^<b>Everhour<\/b>: Jan Kowalski \(id 1001, rola member\)/);
  assert.match(r.msgs[0].text, /<b>Ostatnie 7 dni<\/b>/);
  assert.ok(!r.msgs[0].text.includes(EVERHOUR_KEY), '/status leaked the API key');
  seq = await lastSeq();
  await say('/tydzien');
  r = await messagesAfter(seq, 1, '/tydzien');
  assert.match(r.msgs[0].text, /^<b>Tydzień /);
  assert.match(r.msgs[0].text, /: 8 h \(dziś\)/);
  log('ok   /status (without the API key) and /tydzien');

  seq = await lastSeq();
  await say(`0 do ${warsawDate(9)}`);
  r = await messagesAfter(seq, 1, 'day-off range');
  assert.match(r.msgs[0].text, /^OK, wolne od <b>.*<\/b> do <b>.*<\/b> \(\d+ dni robocz(e|ych)\)\. Do tego czasu nie przypominam\./);
  seq = await lastSeq();
  await say('wracam');
  r = await messagesAfter(seq, 1, 'wracam');
  assert.match(r.msgs[0].text, /^OK, odwołuję wolne: .*Przypomnienia wracają\.$/);
  seq = await lastSeq();
  await say('co tam');
  r = await messagesAfter(seq, 1, 'unknown text');
  assert.match(r.msgs[0].text, /^Nie rozumiem\./);
  log('ok   day-off range, "wracam", unknown text');

  const unexpected = (await mockState()).calls.filter((c) => c.api !== 'everhour' && c.api !== 'telegram');
  assert.deepStrictEqual(unexpected, [], 'the workflow called a host that is not Everhour or Telegram');
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().then(() => {
  log('\ne2e passed');
}).catch(async (e) => {
  console.error(`\nFAIL ${e.stack || e}`);
  try {
    const st = await mockState();
    console.error('\nlast calls seen by the mock:');
    for (const c of st.calls.slice(-12)) console.error(`  ${c.seq} ${c.api} ${c.method} ${c.path} ${JSON.stringify(c.body).slice(0, 300)}`);
  } catch (err) { /* mock is gone */ }
  process.exitCode = 1;
}).finally(async () => {
  await saveLogs();
  if (process.env.E2E_KEEP === '1') log('containers left running (E2E_KEEP=1)');
  else cleanup();
});
