// Local harness for the n8n Code node bodies: mocks $() and pins Luxon "now".
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { DateTime, Settings } = require('luxon');

const load = (name) => fs.readFileSync(path.join(__dirname, 'nodes', `${name}.js`), 'utf8');
function run(name, nodes, nowISO) {
  Settings.now = () => Date.now();
  if (nowISO) {
    const ms = DateTime.fromISO(nowISO, { zone: 'Europe/Warsaw' }).toMillis();
    Settings.now = () => ms;
  }
  const $ = (n) => {
    if (!(n in nodes)) throw new Error(`Node '${n}' hasn't been executed`);
    const items = nodes[n].map((j) => ({ json: j }));
    return { first: () => items[0], all: () => items, isExecuted: true };
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('$', 'DateTime', load(name));
  return fn($, DateTime).map((i) => i.json);
}

let passed = 0;
const test = (title, f) => {
  try { f(); passed += 1; console.log(`ok   ${title}`); } catch (e) { console.log(`FAIL ${title}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); process.exitCode = 1; }
};

const cfg = { TELEGRAM_CHAT_ID: '111', MIN_HOURS: 6, MAX_HOURS: 10, LOCK_DAYS: 2, EVERHOUR_TASK_ID: '' };
const meOk = { statusCode: 200, body: { id: 1001, name: 'Jan Kowalski', role: 'member', timezone: 2, apiKey: 'SECRET', timeTrackingPolicy: { allowTrackingAfterDays: 2 } } };
const rec = (id, date, hours, task = 'ev:1', name = 'Development') => ({ id, date, time: Math.round(hours * 3600), user: 1001, task: { id: task, name } });
const timeOk = (records) => ({ statusCode: 200, body: records });

// ---------- Compute target day
const target = (nowISO) => run('compute_target', { Config: [{ ...cfg, test_now: nowISO }] })[0];

test('Sat 09:30 targets Friday, morning slot, Friday still editable', () => {
  const t = target('2026-10-10T09:30:00');
  assert.strictEqual(t.target, '2026-10-09');
  assert.strictEqual(t.isWorkday, true);
  assert.strictEqual(t.slot, 'morning');
  assert.strictEqual(t.oldestEditable, '2026-10-09');
});
test('Mon 09:30 targets Sunday (not a workday)', () => {
  const t = target('2026-10-12T09:30:00');
  assert.strictEqual(t.target, '2026-10-11');
  assert.strictEqual(t.isWorkday, false);
});
test('21:30 is evening, 14:00 afternoon', () => {
  assert.strictEqual(target('2026-10-14T21:30:00').slot, 'evening');
  assert.strictEqual(target('2026-10-14T14:00:00').slot, 'afternoon');
});
test('DST end (25.10): Mon 26.10 09:30 targets Sun 25.10', () => {
  const t = target('2026-10-26T09:30:00');
  assert.strictEqual(t.target, '2026-10-25');
});

// ---------- Decide
const decide = (nowISO, { state = [{}], me = meOk, time = timeOk([]), c = cfg } = {}) => {
  const t = run('compute_target', { Config: [{ ...c, test_now: nowISO }] })[0];
  return run('decide', {
    Config: [c],
    'Compute target day': [t],
    'Get reminder state': state,
    'Everhour: me (check)': [me],
    'Everhour: time (check)': [time],
  });
};

test('missing Friday -> reminder with Wolne button, state pending pings 1', () => {
  const out = decide('2026-10-10T09:30:00', { time: timeOk([rec(1, '2026-10-08', 8)]) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].route, 'button');
  assert.strictEqual(out[0].buttonData, 'off|2026-10-09');
  assert.match(out[0].text, /Brak godzin w Everhourze za <b>piątek 9\.10<\/b>/);
  assert.match(out[0].text, /zaloguję na „Development”/);
  assert.match(out[0].text, /<code>2026-10-09<\/code>$/);
  assert.deepStrictEqual(out[0].state, { date: '2026-10-09', status: 'pending', hours: 0, pings: 1, note: 'missing' });
  console.log('     ' + out[0].text.replace(/\n/g, '\n     '));
});
test('evening ping after 2 pings -> "Ostatnie przypomnienie", pings 3', () => {
  const out = decide('2026-10-10T21:30:00', { state: [{ date: '2026-10-09', status: 'pending', pings: 2, hours: 0 }] });
  assert.strictEqual(out.length, 1);
  assert.match(out[0].text, /^Ostatnie przypomnienie\. /);
  assert.match(out[0].text, /O północy ten dzień się zablokuje\./);
  assert.strictEqual(out[0].state.pings, 3);
});
test('8 h logged, no state -> nothing', () => {
  assert.deepStrictEqual(decide('2026-10-10T09:30:00', { time: timeOk([rec(1, '2026-10-09', 8)]) }), []);
});
test('8 h logged after a pending reminder -> state logged, no message', () => {
  const out = decide('2026-10-10T14:00:00', { state: [{ date: '2026-10-09', status: 'pending', pings: 1 }], time: timeOk([rec(1, '2026-10-09', 8)]) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].route, 'none');
  assert.strictEqual(out[0].state.status, 'logged');
});
test('5 h -> outlier "tylko 5 h" with OK button', () => {
  const out = decide('2026-10-10T09:30:00', { time: timeOk([rec(1, '2026-10-09', 3), rec(2, '2026-10-09', 2, 'ev:2', 'Meetings')]) });
  assert.strictEqual(out[0].buttonData, 'ok|2026-10-09');
  assert.match(out[0].text, /tylko 5 h/);
  assert.strictEqual(out[0].state.note, 'low');
});
test('14,5 h -> outlier "aż 14,5 h"', () => {
  const out = decide('2026-10-10T09:30:00', { time: timeOk([rec(1, '2026-10-09', 14.5)]) });
  assert.match(out[0].text, /aż 14,5 h/);
});
test('status ok / day_off / logged / missed -> nothing', () => {
  for (const status of ['ok', 'day_off', 'logged', 'missed']) {
    assert.deepStrictEqual(decide('2026-10-10T09:30:00', { state: [{ date: '2026-10-09', status }] }), [], status);
  }
});
test('Everhour 401 -> fail-open reminder', () => {
  const out = decide('2026-10-10T09:30:00', { me: { statusCode: 401, body: { code: 401, message: 'Invalid API key' } } });
  assert.strictEqual(out[0].route, 'button');
  assert.match(out[0].text, /Nie mogę sprawdzić Everhoura \(HTTP 401: Invalid API key\)/);
  assert.strictEqual(out[0].state.note, 'everhour check failed');
});
test('Everhour network error item -> fail-open reminder', () => {
  const out = decide('2026-10-10T09:30:00', { me: { error: { message: 'ETIMEDOUT' } } });
  assert.match(out[0].text, /ETIMEDOUT/);
});
test('Mon 09:30: Friday still pending and empty -> locked notice; Sunday target ignored', () => {
  const out = decide('2026-10-12T09:30:00', { state: [{ date: '2026-10-09', status: 'pending', pings: 3 }], time: timeOk([rec(1, '2026-10-08', 8)]) });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].route, 'plain');
  assert.match(out[0].text, /<b>piątek 9\.10<\/b> został bez godzin/);
  assert.deepStrictEqual(out[0].state, { date: '2026-10-09', status: 'missed', hours: 0, pings: 3, note: 'locked without entry' });
});
test('Mon 09:30: Friday pending but logged on Saturday night -> logged, silent', () => {
  const out = decide('2026-10-12T09:30:00', { state: [{ date: '2026-10-09', status: 'pending', pings: 3 }], time: timeOk([rec(1, '2026-10-09', 8)]) });
  assert.strictEqual(out[0].route, 'none');
  assert.strictEqual(out[0].state.status, 'logged');
});
test('locked-day check skipped when Everhour is down (no false alarm)', () => {
  const out = decide('2026-10-12T09:30:00', { state: [{ date: '2026-10-09', status: 'pending', pings: 3 }], me: { statusCode: 503, body: '' } });
  assert.deepStrictEqual(out, []);
});
test('EVERHOUR_TASK_ID from Config wins for the task name', () => {
  const c = { ...cfg, EVERHOUR_TASK_ID: 'ev:2' };
  const out = decide('2026-10-10T09:30:00', { c, time: timeOk([rec(1, '2026-10-08', 4), rec(2, '2026-10-07', 4, 'ev:2', 'Client dev')]) });
  assert.match(out[0].text, /„Client dev”/);
});
test('task names are HTML-escaped', () => {
  const out = decide('2026-10-10T09:30:00', { time: timeOk([rec(1, '2026-10-08', 8, 'ev:1', 'R&D <ops>')]) });
  assert.match(out[0].text, /R&amp;D &lt;ops&gt;/);
});
test('empty TELEGRAM_CHAT_ID -> clear error', () => {
  assert.throws(() => decide('2026-10-10T09:30:00', { c: { ...cfg, TELEGRAM_CHAT_ID: '' } }), /TELEGRAM_CHAT_ID is empty/);
});

// ---------- Parse update
const msg = (text, extra = {}) => ({ ...cfg, update_id: 1, message: { message_id: 5, chat: { id: 111 }, text, ...extra } });
const parse = (update, nowISO) => run('parse_update', { Config: [update] }, nowISO);

test('hours formats', () => {
  const cases = { '8': 8, '7,5': 7.5, '7.5': 7.5, '7:30': 7.5, '7h30': 7.5, '7h 30m': 7.5, '7 h 30 min': 7.5, '7.5h': 7.5, '8H': 8, '450 min': 7.5, '450m': 7.5, '7godz': 7, '6 godzin': 6, '7:20': 440 / 60 };
  for (const [input, h] of Object.entries(cases)) {
    const o = parse(msg(input))[0];
    assert.strictEqual(o.intent, 'log', input);
    assert.ok(Math.abs(o.hours - h) < 1e-9, `${input} -> ${o.hours}`);
    assert.strictEqual(o.seconds % 60, 0);
  }
});
test('comment after the number is kept (original case)', () => {
  const o = parse(msg('7,5 Deploy prod, review'))[0];
  assert.strictEqual(o.hours, 7.5);
  assert.strictEqual(o.comment, 'Deploy prod, review');
  const o2 = parse(msg('7h code review'))[0];
  assert.strictEqual(o2.hours, 7);
  assert.strictEqual(o2.comment, 'code review');
});
test('date tag is taken from the replied-to reminder', () => {
  const o = parse(msg('8', { reply_to_message: { text: 'Brak godzin w Everhourze za piątek 9.10.\n...\n2026-10-09' } }))[0];
  assert.strictEqual(o.date, '2026-10-09');
});
test('wolne / ok / 0 / commands', () => {
  assert.strictEqual(parse(msg('Wolne'))[0].status, 'day_off');
  assert.strictEqual(parse(msg('0'))[0].status, 'day_off');
  assert.strictEqual(parse(msg('ok'))[0].status, 'ok');
  assert.strictEqual(parse(msg('/status'))[0].intent, 'status');
  assert.strictEqual(parse(msg('/status@EverhourBot'))[0].intent, 'status');
  assert.match(parse(msg('/start'))[0].text, /Pilnuję godzin/);
});
test('garbage and out-of-range values are rejected politely', () => {
  assert.match(parse(msg('abc'))[0].text, /Nie rozumiem/);
  assert.match(parse(msg('20'))[0].text, /Maksymalnie 16 h/);
  assert.match(parse(msg('1:5'))[0].text, /Nie rozumiem/);
});
test('every form of zero = day off, never a log; text after it is kept', () => {
  for (const input of ['0', '0h', '0 h', '0:00', '0,0', '0.0']) {
    const o = parse(msg(input))[0];
    assert.strictEqual(o.intent, 'mark', input);
    assert.strictEqual(o.status, 'day_off', input);
  }
  const l4 = parse(msg('0 L4', { reply_to_message: { text: 'Brak godzin...\n2026-10-09' } }))[0];
  assert.deepStrictEqual([l4.intent, l4.status, l4.date, l4.comment], ['mark', 'day_off', '2026-10-09', 'L4']);
  assert.strictEqual(parse(msg('L4'))[0].status, 'day_off');
  assert.strictEqual(parse(msg('wolne chorobowe'))[0].comment, 'chorobowe');
  assert.strictEqual(parse(msg('Urlop'))[0].status, 'day_off');
  assert.strictEqual(parse(msg('0,5'))[0].intent, 'log');
});
test('off button carries an optional note', () => {
  const o = parse({ ...cfg, update_id: 3, callback_query: { id: 'cb2', data: 'off|2026-10-11|L4', message: { chat: { id: 111 } } } })[0];
  assert.deepStrictEqual([o.intent, o.status, o.date, o.comment], ['mark', 'day_off', '2026-10-11', 'L4']);
});
test('stranger chat is ignored silently', () => {
  assert.deepStrictEqual(parse({ ...msg('8'), message: { chat: { id: 999 }, text: '8' } }), []);
});
test('bootstrap: empty TELEGRAM_CHAT_ID -> replies with chat_id', () => {
  const o = parse({ ...msg('/start'), TELEGRAM_CHAT_ID: '' })[0];
  assert.match(o.text, /Twój chat_id: <code>111<\/code>/);
  assert.strictEqual(o.chatId, '111');
});
test('callback buttons', () => {
  const cbu = (data) => ({ ...cfg, update_id: 2, callback_query: { id: 'cb1', data, message: { chat: { id: 111 } } } });
  assert.deepStrictEqual((({ intent, status, date, isCallback, callbackId }) => ({ intent, status, date, isCallback, callbackId }))(parse(cbu('off|2026-10-09'))[0]), { intent: 'mark', status: 'day_off', date: '2026-10-09', isCallback: true, callbackId: 'cb1' });
  assert.strictEqual(parse(cbu('ok|2026-10-09'))[0].status, 'ok');
  const l = parse(cbu('log|2026-10-10|27000'))[0];
  assert.strictEqual(l.intent, 'log');
  assert.strictEqual(l.hours, 7.5);
  assert.match(parse(cbu('cancel'))[0].text, /nic nie wpisuję/);
});

// ---------- Resolve action
const resolve = (p, pending = [{}], nowISO = '2026-10-10T12:00:00') => run('resolve_action', { 'Parse update': [p], Config: [cfg], 'Get pending days': pending }, nowISO)[0];
const P = (o) => ({ chatId: '111', isCallback: false, callbackId: '', intent: 'log', status: '', date: '', hours: 8, seconds: 28800, comment: '', text: '', ...o });

test('log without date uses the newest editable pending day', () => {
  const r = resolve(P({}), [{ date: '2026-10-09', status: 'pending' }, { date: '2026-10-01', status: 'pending' }]);
  assert.strictEqual(r.route, 'log');
  assert.strictEqual(r.date, '2026-10-09');
  assert.strictEqual(r.from, '2026-08-25');
});
test('log without date and nothing pending -> ask today/yesterday', () => {
  const r = resolve(P({ hours: 7.5, seconds: 27000 }));
  assert.strictEqual(r.route, 'ask');
  assert.strictEqual(r.todayData, 'log|2026-10-10|27000');
  assert.strictEqual(r.yesterdayLabel, 'Wczoraj, piątek 9.10');
  assert.match(r.text, /7,5 h/);
});
test('log for a locked day is refused', () => {
  const r = resolve(P({ date: '2026-10-08' }));
  assert.strictEqual(r.route, 'reply');
  assert.match(r.text, /poza oknem edycji/);
});
test('log for tomorrow is refused', () => {
  assert.match(resolve(P({ date: '2026-10-11' })).text, /z wyprzedzeniem/);
});
test('0 without a reminder (sick today) -> asks today/yesterday with off buttons', () => {
  const r = resolve(P({ intent: 'mark', status: 'day_off', hours: 0, seconds: 0, comment: 'L4' }), [{}], '2026-10-13T08:10:00');
  assert.strictEqual(r.route, 'ask');
  assert.strictEqual(r.text, 'Który dzień oznaczyć jako wolny?');
  assert.strictEqual(r.todayData, 'off|2026-10-13|L4');
  assert.strictEqual(r.yesterdayData, 'off|2026-10-12|L4');
  assert.strictEqual(r.todayLabel, 'Dziś, wtorek 13.10');
});
test('off callback data stays within 64 bytes even with a long emoji note', () => {
  const r = resolve(P({ intent: 'mark', status: 'day_off', hours: 0, seconds: 0, comment: '🤒'.repeat(30) + '|x' }), [{}], '2026-10-13T08:10:00');
  assert.ok(Buffer.byteLength(r.todayData) <= 64, Buffer.byteLength(r.todayData));
  assert.ok(!r.todayData.slice(4).includes('|x'));
});
test('day off with a note -> reply and state note carry it', () => {
  const r = resolve(P({ intent: 'mark', status: 'day_off', date: '2026-10-09', comment: 'L4 <emergency>' }));
  assert.strictEqual(r.route, 'mark');
  assert.strictEqual(r.text, 'OK, <b>piątek 9.10</b> to dzień wolny (L4 &lt;emergency&gt;). Nie przypominam.');
  assert.strictEqual(r.states[0].state.note, 'telegram: L4 <emergency>');
});
test('ok without date and nothing pending -> hint', () => {
  assert.match(resolve(P({ intent: 'mark', status: 'ok', hours: 0, seconds: 0 })).text, /Nie mam otwartego przypomnienia/);
});
test('mark ok with date -> route mark with state', () => {
  const r = resolve(P({ intent: 'mark', status: 'ok', date: '2026-10-09' }));
  assert.strictEqual(r.route, 'mark');
  assert.deepStrictEqual(r.states, [{ state: { date: '2026-10-09', status: 'ok', note: 'telegram' } }]);
});
test('status -> 7-day window', () => {
  const r = resolve(P({ intent: 'status' }));
  assert.strictEqual(r.route, 'status');
  assert.strictEqual(r.from, '2026-10-04');
});

// ---------- Plan time entry
const plan = (r, records, c = cfg, me = meOk) => run('plan_entry', { 'Resolve action': [r], Config: [c], 'Everhour: me (log)': [me], 'Everhour: time (log)': [timeOk(records)] })[0];
const R = (o) => ({ chatId: '111', date: '2026-10-09', seconds: 28800, hours: 8, comment: '', route: 'log', ...o });

test('empty day -> POST with task from newest entry and user id', () => {
  const p = plan(R({}), [rec(1, '2026-10-07', 8, 'ev:9', 'Old'), rec(2, '2026-10-08', 8, 'ev:1', 'Development')]);
  assert.strictEqual(p.write, true);
  assert.strictEqual(p.method, 'POST');
  assert.strictEqual(p.url, 'https://api.everhour.com/time');
  assert.deepStrictEqual(p.body, { task: 'ev:1', user: 1001, date: '2026-10-09', time: 28800 });
});
test('existing entry on the same task -> PUT to that record', () => {
  const p = plan(R({}), [rec(7, '2026-10-09', 5, 'ev:1')]);
  assert.strictEqual(p.method, 'PUT');
  assert.strictEqual(p.url, 'https://api.everhour.com/time/7');
  assert.strictEqual(p.body.time, 28800);
  assert.strictEqual(p.previous, 18000);
});
test('other task present -> main task = most time in 14 days, only the difference goes there', () => {
  const p = plan(R({}), [rec(7, '2026-10-09', 2, 'ev:2', 'Meetings'), rec(6, '2026-10-08', 8, 'ev:1')]);
  assert.strictEqual(p.method, 'POST');
  assert.strictEqual(p.body.task, 'ev:1');
  assert.strictEqual(p.body.time, 6 * 3600);
});
test('a one-off HR entry as the newest record does not become the main task', () => {
  const recs = [rec(1, '2026-10-06', 8, 'ev:dev', '[Acme] Development'), rec(2, '2026-10-07', 8, 'ev:dev', '[Acme] Development'), rec(3, '2026-10-08', 1, 'ev:hr', '[Acme] HR')];
  assert.strictEqual(plan(R({}), recs).body.task, 'ev:dev');
  const out = decide('2026-10-10T09:30:00', { time: timeOk(recs) });
  assert.match(out[0].text, /„\[Acme\] Development”/);
});
test('with EVERHOUR_TASK_ID the remainder is added to that task', () => {
  const p = plan(R({}), [rec(7, '2026-10-09', 2, 'ev:2', 'Meetings'), rec(6, '2026-10-08', 8, 'ev:1')], { ...cfg, EVERHOUR_TASK_ID: 'ev:1' });
  assert.strictEqual(p.method, 'POST');
  assert.strictEqual(p.body.task, 'ev:1');
  assert.strictEqual(p.body.time, 6 * 3600);
});
test('same total -> nothing to change', () => {
  const p = plan(R({}), [rec(7, '2026-10-09', 8)]);
  assert.strictEqual(p.write, false);
  assert.match(p.text, /jest już 8 h/);
});
test('other tasks already above desired -> manual fix', () => {
  const p = plan(R({ seconds: 3600, hours: 1 }), [rec(7, '2026-10-09', 2, 'ev:2'), rec(6, '2026-10-08', 8, 'ev:1')], { ...cfg, EVERHOUR_TASK_ID: 'ev:1' });
  assert.strictEqual(p.write, false);
  assert.match(p.text, /na innych taskach/);
});
test('no history and no EVERHOUR_TASK_ID -> asks for config', () => {
  assert.match(plan(R({}), []).text, /EVERHOUR_TASK_ID/);
});
test('comment is passed to Everhour', () => {
  assert.strictEqual(plan(R({ comment: 'deploy' }), [rec(2, '2026-10-08', 8)]).body.comment, 'deploy');
});
test('profile 401 -> reply, no write', () => {
  const p = plan(R({}), [], cfg, { statusCode: 401, body: { message: 'Invalid API key' } });
  assert.strictEqual(p.write, false);
  assert.match(p.text, /HTTP 401/);
});

// ---------- Format log result
const fmt = (planOut, res) => run('format_log', { 'Plan time entry': [planOut], 'Everhour: save time': [res] })[0];
test('201 -> confirmation with total and previous value', () => {
  const pl = plan(R({}), [rec(7, '2026-10-09', 2, 'ev:2', 'Meetings'), rec(6, '2026-10-08', 8, 'ev:1', 'Development')], { ...cfg, EVERHOUR_TASK_ID: 'ev:1' });
  const o = fmt(pl, { statusCode: 201, body: { id: 99, time: 21600 } });
  assert.strictEqual(o.ok, true);
  assert.strictEqual(o.text, 'Zapisane: <b>8 h</b> za piątek 9.10 (było 2 h), task „Development”.');
  assert.deepStrictEqual(o.state, { date: '2026-10-09', status: 'logged', hours: 8, note: 'telegram' });
});
test('422 -> error text, ok false', () => {
  const pl = plan(R({}), [rec(6, '2026-10-08', 8)]);
  const o = fmt(pl, { statusCode: 422, body: { code: 422, message: 'Time is locked' } });
  assert.strictEqual(o.ok, false);
  assert.match(o.text, /Everhour odrzucił wpis za <b>piątek 9\.10<\/b> \(HTTP 422: Time is locked\)/);
});

// ---------- Format status
test('/status shows timezone vs Warsaw, policy, 7 days, never the API key', () => {
  const o = run('format_status', {
    'Resolve action': [{ chatId: '111' }],
    'Everhour: me (status)': [{ statusCode: 200, body: { ...meOk.body, timezone: 2, team: { id: 1, name: 'Acme', workdays: [1, 2, 3, 4, 5], timeLimits: { lockAfterDays: 2 }, billing: { x: 1 } } } }],
    'Everhour: time (status)': [timeOk([rec(1, '2026-10-09', 8), rec(2, '2026-10-08', 7.5)])],
  }, '2026-10-27T10:00:00')[0];
  assert.ok(!o.text.includes('SECRET'));
  assert.match(o.text, /Strefa w profilu: UTC\+2; Warszawa teraz: UTC\+1 \(różnica!\)/);
  assert.match(o.text, /timeLimits/);
  assert.ok(!o.text.includes('billing'));
  console.log('     ' + o.text.replace(/\n/g, '\n     '));
});


// ---------- Day-off ranges ("0 do piątku")
const TUE = '2026-10-13T08:10:00'; // wtorek
test('range parsing: weekdays, jutra, końca tygodnia, dates', () => {
  const u = (t) => parse(msg(t), TUE)[0];
  assert.deepStrictEqual([u('0 do piątku').intent, u('0 do piątku').until, u('0 do piątku').comment], ['mark', '2026-10-16', '']);
  assert.strictEqual(u('wolne do pt').until, '2026-10-16');
  assert.strictEqual(u('L4 do czwartku').until, '2026-10-15');
  assert.strictEqual(u('L4 do czwartku').comment, 'L4');
  assert.strictEqual(u('0 do środy').until, '2026-10-14');
  assert.strictEqual(u('0 do wtorku').until, '2026-10-13');
  assert.strictEqual(u('0 do poniedziałku').until, '2026-10-19');
  assert.strictEqual(u('wolne do jutra').until, '2026-10-14');
  assert.strictEqual(u('0 do końca tygodnia').until, '2026-10-16');
  assert.strictEqual(u('urlop do 23.10').until, '2026-10-23');
  assert.strictEqual(u('urlop do 23.10').comment, 'urlop');
  assert.strictEqual(u('0 do 2026-10-20').until, '2026-10-20');
  assert.strictEqual(u('0 L4 do 16/10').until, '2026-10-16');
  assert.strictEqual(u('0 L4 do 16/10').comment, 'L4');
  assert.strictEqual(u('0 do 16.10 grypa').comment, 'grypa');
});
test('DD.MM in the past means next year', () => {
  assert.strictEqual(parse(msg('urlop do 5.01'), '2026-12-28T10:00:00')[0].until, '2027-01-05');
});
test('hours with "do X" are refused, but a log comment containing "do ..." still logs', () => {
  assert.match(parse(msg('8 do piątku'), TUE)[0].text, /nie wpisuję z wyprzedzeniem/);
  const o = parse(msg('7,5 przygotowanie do 16.10 release'), TUE)[0];
  assert.strictEqual(o.intent, 'log');
  assert.strictEqual(o.comment, 'przygotowanie do 16.10 release');
  const o2 = parse(msg('6 dojazd do klienta'), TUE)[0];
  assert.strictEqual(o2.intent, 'log');
  assert.strictEqual(o2.comment, 'dojazd do klienta');
});
test('wracam -> resume intent', () => {
  assert.strictEqual(parse(msg('wracam'), TUE)[0].intent, 'resume');
  assert.strictEqual(parse(msg('Wróciłem'), TUE)[0].intent, 'resume');
});

const resolveAt = (p, pending, nowISO) => run('resolve_action', { 'Parse update': [p], Config: [cfg], 'Get pending days': pending }, nowISO)[0];
test('standalone "0 do piątku" on Tuesday -> Tue..Fri, no question', () => {
  const r = resolveAt(P({ intent: 'mark', status: 'day_off', until: '2026-10-16', hours: 0, seconds: 0, comment: 'L4' }), [{}], TUE);
  assert.strictEqual(r.route, 'mark');
  assert.deepStrictEqual(r.states.map((x) => x.state.date), ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  assert.ok(r.states.every((x) => x.state.status === 'day_off' && x.state.note === 'telegram: L4 do 2026-10-16'));
  assert.strictEqual(r.text, 'OK, wolne od <b>wtorek 13.10</b> do <b>piątek 16.10</b> (4 dni robocze) (L4). Do tego czasu nie przypominam.');
});
test('standalone range with yesterday still open -> starts today and says yesterday waits', () => {
  const r = resolveAt(P({ intent: 'mark', status: 'day_off', until: '2026-10-16', hours: 0, seconds: 0 }), [{ date: '2026-10-12', status: 'pending' }], TUE);
  assert.strictEqual(r.states[0].state.date, '2026-10-13');
  assert.match(r.text, /<b>poniedziałek 12\.10<\/b> nadal czeka na odpowiedź/);
});
test('range as a reply to the Monday reminder -> starts Monday, skips the weekend', () => {
  const r = resolveAt(P({ intent: 'mark', status: 'day_off', date: '2026-10-12', until: '2026-10-20', hours: 0, seconds: 0 }), [{ date: '2026-10-12', status: 'pending' }], TUE);
  assert.deepStrictEqual(r.states.map((x) => x.state.date), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20']);
  assert.match(r.text, /\(7 dni roboczych\)/);
  assert.ok(!/nadal czeka/.test(r.text));
});
test('range edge cases: end before start, too far, weekend only, single day', () => {
  assert.match(resolveAt(P({ intent: 'mark', status: 'day_off', date: '2026-10-13', until: '2026-10-12', hours: 0, seconds: 0 }), [{}], TUE).text, /wypada przed/);
  assert.match(resolveAt(P({ intent: 'mark', status: 'day_off', until: '2026-12-31', hours: 0, seconds: 0 }), [{}], TUE).text, /Maksymalnie 45 dni/);
  assert.match(resolveAt(P({ intent: 'mark', status: 'day_off', until: '2026-10-18', hours: 0, seconds: 0 }), [{}], '2026-10-17T10:00:00').text, /nie ma dni roboczych/);
  const one = resolveAt(P({ intent: 'mark', status: 'day_off', until: '2026-10-13', hours: 0, seconds: 0 }), [{}], TUE);
  assert.strictEqual(one.text, 'OK, wolne <b>wtorek 13.10</b>. Do tego czasu nie przypominam.');
});
test('wracam cancels only bot-set future days off', () => {
  const rows = [
    { date: '2026-10-12', status: 'day_off', note: 'telegram: L4 do 2026-10-16' },
    { date: '2026-10-14', status: 'day_off', note: 'telegram: L4 do 2026-10-16' },
    { date: '2026-10-13', status: 'day_off', note: 'telegram: L4 do 2026-10-16' },
    { date: '2026-10-15', status: 'day_off', note: 'set outside the bot' },
    { date: '2026-10-12', status: 'pending' },
  ];
  const r = resolveAt(P({ intent: 'resume', hours: 0, seconds: 0 }), rows, TUE);
  assert.strictEqual(r.route, 'mark');
  assert.deepStrictEqual(r.states.map((x) => [x.state.date, x.state.status]), [['2026-10-13', 'cancelled'], ['2026-10-14', 'cancelled']]);
  assert.strictEqual(r.text, 'OK, odwołuję wolne: wtorek 13.10, środa 14.10. Przypomnienia wracają.');
  assert.match(resolveAt(P({ intent: 'resume', hours: 0, seconds: 0 }), [{}], TUE).text, /Nie mam zaplanowanego wolnego/);
});
test('a cancelled day is reminded again by the scheduler', () => {
  const out = decide('2026-10-14T09:30:00', { state: [{ date: '2026-10-13', status: 'cancelled', note: 'telegram: wracam' }] });
  assert.strictEqual(out[0].route, 'button');
  assert.strictEqual(out[0].state.pings, 1);
});
test('/status lists planned days off', () => {
  const o = run('format_status', {
    'Resolve action': [{ chatId: '111' }],
    'Everhour: me (status)': [{ statusCode: 200, body: { id: 1, name: 'M', role: 'member', timezone: 2 } }],
    'Everhour: time (status)': [timeOk([])],
    'Get pending days': [{ date: '2026-10-15', status: 'day_off' }, { date: '2026-10-14', status: 'day_off' }, { date: '2026-10-12', status: 'day_off' }, { date: '2026-10-14', status: 'pending' }],
  }, TUE)[0];
  assert.match(o.text, /<b>Zaplanowane wolne<\/b>: środa 14\.10, czwartek 15\.10$/);
});

// ---------- Reports (/tydzien, /raport)
const SUN = '2026-10-11T12:00:00'; // niedziela
test('/tydzien: current and previous ISO week', () => {
  const w = parse(msg('/tydzien'), SUN)[0];
  assert.deepStrictEqual([w.intent, w.reportKind, w.from, w.to, w.period], ['report', 'week', '2026-10-05', '2026-10-11', '5.10–11.10']);
  const p = parse(msg('/tydzien poprzedni'), SUN)[0];
  assert.deepStrictEqual([p.from, p.to, p.period], ['2026-09-28', '2026-10-04', '28.09–4.10']);
  assert.strictEqual(parse(msg('/tydzień zeszły'), SUN)[0].from, '2026-09-28');
  assert.strictEqual(parse(msg('/tydzien@EverhourBot'), SUN)[0].from, '2026-10-05');
  assert.strictEqual(parse(msg('/tydzien@EverhourBot poprzedni'), SUN)[0].from, '2026-09-28');
  assert.strictEqual(parse(msg('/tydzien'), '2026-10-12T00:05:00')[0].from, '2026-10-12');
  assert.match(parse(msg('/tydzien 3'), SUN)[0].text, /Użyj <code>\/tydzien<\/code>/);
});
test('/raport: default previous month, current, number, name, ISO, MM.YYYY', () => {
  const m = (t, now = SUN) => parse(msg(t), now)[0];
  const d = m('/raport');
  assert.deepStrictEqual([d.intent, d.reportKind, d.from, d.to, d.period, d.running], ['report', 'month', '2026-09-01', '2026-09-30', 'wrzesień 2026', false]);
  const c = m('/raport bieżący');
  assert.deepStrictEqual([c.from, c.to, c.running], ['2026-10-01', '2026-10-31', true]);
  assert.strictEqual(m('/raport biezacy').from, '2026-10-01');
  assert.strictEqual(m('/raport 9').from, '2026-09-01');
  assert.deepStrictEqual([m('/raport 11').from, m('/raport 11').period], ['2025-11-01', 'listopad 2025']);
  assert.strictEqual(m('/raport 2026-02').to, '2026-02-28');
  assert.strictEqual(m('/raport 12.2025').from, '2025-12-01');
  assert.strictEqual(m('/raport wrzesień').from, '2026-09-01');
  assert.strictEqual(m('/raport Wrzesien').from, '2026-09-01');
  assert.strictEqual(m('/raport październik').running, true);
  assert.strictEqual(m('/raport paź 2025').from, '2025-10-01');
  assert.strictEqual(m('/raport grudzień').from, '2025-12-01');
  assert.strictEqual(m('/raport@EverhourBot 9').from, '2026-09-01');
  assert.strictEqual(m('/raport', '2027-01-05T10:00:00').period, 'grudzień 2026');
  assert.strictEqual(m('/raport', '2026-11-01T00:30:00').period, 'październik 2026');
  assert.match(m('/raport 2026-12').text, /jeszcze się nie zaczął/);
  assert.match(m('/raport 13').text, /Nie rozpoznaję miesiąca/);
  assert.match(m('/raport foo').text, /Nie rozpoznaję miesiąca/);
});
test('report intent routes straight to report with its range', () => {
  const p = parse(msg('/raport'), SUN)[0];
  const r = resolveAt(p, [{ date: '2026-10-09', status: 'pending' }], SUN);
  assert.deepStrictEqual([r.route, r.from, r.to, r.reportKind, r.chatId], ['report', '2026-09-01', '2026-09-30', 'month', '111']);
});
test('help lists the report commands', () => {
  const h = parse(msg('/help'), SUN)[0].text;
  assert.match(h, /\n\/tydzien: /);
  assert.match(h, /\n\/raport: /);
  assert.match(h, /\n\/status: /);
});

const meRep = { statusCode: 200, body: { id: 1001, name: 'M', apiKey: 'SECRET' } };
const ok200 = (body) => ({ statusCode: 200, body });
const rep = (r, { users, projects, time = timeOk([]), pending = [{}], me = meRep } = {}, nowISO = SUN) => run('format_report', {
  'Resolve action': [r],
  'Everhour: me (report)': [me],
  'Everhour: users report': [users],
  'Everhour: projects report': [projects],
  'Everhour: time (report)': [time],
  'Get pending days': pending,
}, nowISO)[0];
const SEPT = { chatId: '111', route: 'report', reportKind: 'month', from: '2026-09-01', to: '2026-09-30', period: 'wrzesień 2026', running: false };
const WEEK = { chatId: '111', route: 'report', reportKind: 'week', from: '2026-10-05', to: '2026-10-11', period: '5.10–11.10' };
const urow = (o) => ({ memberId: 1001, memberName: 'M', time: 0, billableTime: 0, nonBillableTime: 0, timeOffTime: 0, timeOffDays: 0, billableAmount: 123456, costs: 98765, ...o });

test('/raport: total is the users-report row as-is, projects listed when they add up', () => {
  const o = rep(SEPT, {
    users: ok200([urow({ memberId: 99, time: 3600 }), urow({ time: 570600, billableTime: 570600 })]),
    projects: ok200([{ projectId: 'as:2', projectName: 'HR', time: 3600 }, { projectId: 'as:1', projectName: 'Acme', time: 567000 }]),
  });
  assert.strictEqual(o.chatId, '111');
  assert.strictEqual(o.text, [
    '<b>Raport Everhour: wrzesień 2026</b> (1.09–30.09)',
    'Łącznie: <b>158 h 30 min</b> (158,5 h)',
    '',
    '<b>Projekty</b>',
    '• Acme: 157 h 30 min',
    '• HR: 1 h',
    '',
    'Źródło: raport Everhour (dashboards/users), bez przeliczeń po stronie bota.',
  ].join('\n'));
  assert.ok(!/123456|98765|SECRET/.test(o.text));
});
test('/raport: time records never feed the month total; odd minutes get an approximate decimal', () => {
  const o = rep(SEPT, { users: ok200([urow({ time: 576000 })]), projects: ok200([{ projectName: 'Acme', time: 576000 }]), time: timeOk([rec(1, '2026-09-01', 99)]) });
  assert.match(o.text, /Łącznie: <b>160 h<\/b>\n/);
  const q = rep(SEPT, { users: ok200([urow({ time: 7 * 3600 + 20 * 60 })]), projects: ok200([]) });
  assert.match(q.text, /Łącznie: <b>7 h 20 min<\/b> \(≈7,33 h\)/);
});
test('/raport: running month, billable split, mismatching or failing projects report', () => {
  const a = rep({ ...SEPT, running: true }, { users: ok200([urow({ time: 7200, billableTime: 3600, nonBillableTime: 3600 })]), projects: ok200([{ projectName: 'X', time: 3600 }]) });
  assert.match(a.text, /\(1\.09–30\.09, miesiąc w toku\)/);
  assert.match(a.text, /Billable: 1 h, non-billable: 1 h/);
  assert.match(a.text, /Rozbicie na projekty pominięte/);
  assert.ok(!/• X/.test(a.text));
  const b = rep(SEPT, { users: ok200([urow({ time: 7200 })]), projects: { statusCode: 403, body: { code: 403, message: 'Forbidden' } } });
  assert.match(b.text, /Rozbicie na projekty niedostępne \(HTTP 403: Forbidden\)/);
  assert.match(b.text, /Łącznie: <b>2 h<\/b>/);
});
test('/raport: no report or a report without my row -> no total; empty report -> 0 h', () => {
  const a = rep(SEPT, { users: { statusCode: 403, body: { code: 403, message: 'Forbidden' } }, projects: ok200([]) });
  assert.strictEqual(a.text, 'Everhour nie zwrócił raportu (HTTP 403: Forbidden). Sumy nie liczę na własną rękę.');
  const b = rep(SEPT, { users: ok200([{ member: { id: 1001 }, time: 3600 }]), projects: ok200([]) });
  assert.strictEqual(b.text, 'Raport Everhoura nie ma wiersza dla Twojego konta (id 1001). Pola w odpowiedzi: member, time. Sumy nie liczę na własną rękę.');
  const c = rep(SEPT, { users: ok200([]), projects: ok200([]) });
  assert.match(c.text, /Łącznie: <b>0 h<\/b>/);
  const d = rep(SEPT, { users: { error: { message: 'timeout' } }, projects: ok200([]) });
  assert.match(d.text, /Everhour nie zwrócił raportu \(timeout\)/);
  const e = rep(SEPT, { users: ok200([]), projects: ok200([]), me: { statusCode: 401, body: { message: 'Invalid API key' } } });
  assert.match(e.text, /nie mogę pobrać profilu \(HTTP 401: Invalid API key\)/);
});
test('/tydzien: total from the report, per-day lines from records, days off marked', () => {
  const o = rep(WEEK, {
    users: ok200([urow({ time: 27 * 3600 })]),
    projects: ok200([{ projectName: 'Acme', time: 27 * 3600 }]),
    time: timeOk([rec(1, '2026-10-05', 8), rec(2, '2026-10-06', 7.5), rec(3, '2026-10-07', 4), rec(4, '2026-10-07', 3.5), rec(5, '2026-10-09', 4)]),
    pending: [{ date: '2026-10-08', status: 'day_off', note: 'telegram: L4' }],
  });
  assert.strictEqual(o.text, [
    '<b>Tydzień 5.10–11.10</b>',
    'Łącznie: <b>27 h</b>',
    '',
    'pn 5.10: 8 h',
    'wt 6.10: 7 h 30 min',
    'śr 7.10: 7 h 30 min',
    'cz 8.10: 0 h (wolne)',
    'pt 9.10: 4 h',
  ].join('\n'));
});
test('/tydzien: mid-week shows today and gaps, warns when records disagree with the report', () => {
  const o = rep(WEEK, {
    users: ok200([urow({ time: 16 * 3600 })]),
    projects: ok200([{ projectName: 'A', time: 9 * 3600 }, { projectName: 'B', time: 7 * 3600 }]),
    time: timeOk([rec(1, '2026-10-05', 8), rec(2, '2026-10-07', 7)]),
  }, '2026-10-07T15:00:00');
  assert.match(o.text, /<b>Projekty<\/b>\n• A: 9 h\n• B: 7 h/);
  assert.match(o.text, /pn 5\.10: 8 h\nwt 6\.10: 0 h \(brak\)\nśr 7\.10: 7 h \(dziś\)$/m);
  assert.match(o.text, /Uwaga: wpisy dzienne dają 15 h, raport Everhoura 16 h\./);
  assert.ok(!/cz 8\.10/.test(o.text));
  const f = rep(WEEK, { users: ok200([urow({ time: 3600 })]), projects: ok200([]), time: { statusCode: 500, body: { message: 'boom' } } });
  assert.match(f.text, /Dni niedostępne \(HTTP 500: boom\)/);
});

// ---------- Schedule guard: daily runs, Everhour check only on its own slots
test('Everhour check runs 9:30 Mon-Sat and 14:00/21:30 Tue-Sat only', () => {
  assert.strictEqual(target('2026-10-11T09:30:00'), undefined); // niedziela
  assert.strictEqual(target('2026-10-11T21:30:00'), undefined);
  assert.strictEqual(target('2026-10-12T14:00:00'), undefined); // poniedziałek po południu
  assert.strictEqual(target('2026-10-12T21:30:00'), undefined);
  assert.ok(target('2026-10-12T09:30:00'));
  assert.ok(target('2026-10-13T14:00:00'));
  assert.ok(target('2026-10-17T21:30:00'));
});

// ---------- Invoice reminders
const invDecide = (nowISO, rows = [{}], c = cfg) => run('decide_invoice', { Config: [{ ...c, test_now: nowISO }], 'Get invoice rows': rows });
test('invoice: heads-up only on the morning before the last workday', () => {
  const out = invDecide('2026-10-29T09:30:00');
  assert.strictEqual(out.length, 1);
  const o = out[0];
  assert.strictEqual(o.text, 'Jutro (<b>piątek 30.10</b>) ostatni dzień roboczy października: faktura za październik.\nPo wystawieniu kliknij „Wystawiona” albo odpisz „wystawiona”.\n<code>faktura 2026-10</code>');
  assert.deepStrictEqual([o.chatId, o.period, o.reportLabel, o.reportData, o.doneData], ['111', '2026-10', 'Raport: październik', 'rep|2026-10', 'inv|2026-10']);
  assert.deepStrictEqual(o.state, { period: '2026-10', status: 'pending', pings: 1, note: 'heads-up' });
  assert.deepStrictEqual(invDecide('2026-10-28T09:30:00'), []);
  assert.deepStrictEqual(invDecide('2026-10-29T14:00:00'), []);
  assert.deepStrictEqual(invDecide('2026-10-29T21:30:00'), []);
  assert.deepStrictEqual(invDecide('2026-10-11T09:30:00'), []);
});
test('invoice: due day reminds every run, wording by slot', () => {
  const rows = [{ period: '2026-10', status: 'pending', pings: 1 }];
  const m = invDecide('2026-10-30T09:30:00', rows)[0];
  assert.match(m.text, /^Dziś \(<b>piątek 30\.10<\/b>\) ostatni dzień roboczy października: wystaw fakturę za październik\.\nNajpierw wpisz dzisiejsze godziny/);
  assert.deepStrictEqual(m.state, { period: '2026-10', status: 'pending', pings: 2, note: 'due' });
  assert.strictEqual(invDecide('2026-10-30T14:00:00', rows)[0].text, 'Przypominam. Faktura za październik czeka na wystawienie.\n<code>faktura 2026-10</code>');
  assert.match(invDecide('2026-10-30T21:30:00', rows)[0].text, /^Termin mija dziś\. /);
  assert.strictEqual(invDecide('2026-10-30T14:00:00')[0].state.note, 'due'); // heads-up missed, still reminds
});
test('invoice: overdue keeps going, also into the next month and on weekends', () => {
  const rows = [{ period: '2026-10', status: 'pending', pings: 4 }];
  const sat = invDecide('2026-10-31T21:30:00', rows);
  assert.strictEqual(sat.length, 1);
  assert.strictEqual(sat[0].text, 'Faktura za październik nadal niewystawiona (termin: <b>piątek 30.10</b>).\n<code>faktura 2026-10</code>');
  const sun = invDecide('2026-11-01T09:30:00', rows);
  assert.deepStrictEqual(sun.map((x) => [x.period, x.state.note]), [['2026-10', 'overdue']]);
  const two = invDecide('2026-12-01T09:30:00', [{ period: '2026-11', status: 'pending' }, rows[0]]);
  assert.deepStrictEqual(two.map((x) => x.period), ['2026-10', '2026-11']);
});
test('invoice: issued month is quiet; Sunday heads-up for a Monday deadline; Jan/Feb ends on a weekend', () => {
  assert.deepStrictEqual(invDecide('2026-10-30T09:30:00', [{ period: '2026-10', status: 'issued' }]), []);
  const nov = invDecide('2026-11-29T09:30:00', [{ period: '2026-10', status: 'issued' }]);
  assert.strictEqual(nov.length, 1);
  assert.match(nov[0].text, /^Jutro \(<b>poniedziałek 30\.11<\/b>\) ostatni dzień roboczy listopada: faktura za listopad\./);
  assert.match(invDecide('2027-01-28T09:30:00')[0].text, /^Jutro \(<b>piątek 29\.01<\/b>\) ostatni dzień roboczy stycznia/);
  assert.match(invDecide('2027-02-25T09:30:00')[0].text, /^Jutro \(<b>piątek 26\.02<\/b>\) ostatni dzień roboczy lutego/);
  assert.deepStrictEqual(invDecide('2026-10-29T09:30:00', [{}], { ...cfg, TELEGRAM_CHAT_ID: '' }), []);
});
test('invoice: INVOICE_REMINDERS = false switches the reminders off', () => {
  const rows = [{ period: '2026-10', status: 'pending', pings: 1 }];
  assert.deepStrictEqual(invDecide('2026-10-30T09:30:00', rows, { ...cfg, INVOICE_REMINDERS: false }), []);
  assert.deepStrictEqual(invDecide('2026-10-30T09:30:00', rows, { ...cfg, INVOICE_REMINDERS: 'false' }), []);
  assert.strictEqual(invDecide('2026-10-30T09:30:00', rows, { ...cfg, INVOICE_REMINDERS: true }).length, 1);
});

test('"wystawiona" and friends -> invoice intent, month from the reminder tag', () => {
  for (const t of ['wystawiona', 'Wystawiona.', 'wystawiłem', 'Wystawilam', 'fv wystawiona', 'Faktura wystawiona!', 'wystawione']) {
    const o = parse(msg(t), SUN)[0];
    assert.deepStrictEqual([o.intent, o.invoicePeriod], ['invoice', ''], t);
  }
  const r = parse(msg('wystawiona', { reply_to_message: { text: 'Przypominam. Faktura za październik czeka na wystawienie.\nfaktura 2026-10' } }), SUN)[0];
  assert.strictEqual(r.invoicePeriod, '2026-10');
  assert.strictEqual(parse(msg('wystawiona faktura'), SUN)[0].intent, 'reply');
});
test('invoice buttons: Wystawiona and Raport', () => {
  const cbu = (data) => ({ ...cfg, update_id: 2, callback_query: { id: 'cb1', data, message: { chat: { id: 111 } } } });
  const i = parse(cbu('inv|2026-10'), SUN)[0];
  assert.deepStrictEqual([i.intent, i.invoicePeriod, i.isCallback], ['invoice', '2026-10', true]);
  const r = parse(cbu('rep|2026-09'), SUN)[0];
  assert.deepStrictEqual([r.intent, r.reportKind, r.from, r.to, r.period, r.running], ['report', 'month', '2026-09-01', '2026-09-30', 'wrzesień 2026', false]);
  assert.strictEqual(parse(cbu('rep|2026-10'), SUN)[0].running, true);
  assert.match(parse(cbu('rep|xx'), SUN)[0].text, /Niepoprawny przycisk raportu/);
  assert.strictEqual(resolveAt(i, [{}], SUN).route, 'invoice');
});

const invResolve = (p, rows = [{}], nowISO = '2026-10-30T15:00:00') => run('resolve_invoice', {
  'Resolve action': [{ chatId: '111', route: 'invoice', invoicePeriod: '', ...p }],
  'Get invoice rows (reply)': rows,
}, nowISO)[0];
test('resolve invoice: explicit month, open reminder, early issue, nothing open, already issued', () => {
  const a = invResolve({ invoicePeriod: '2026-10' });
  assert.strictEqual(a.write, true);
  assert.deepStrictEqual(a.state, { period: '2026-10', status: 'issued', note: 'telegram' });
  assert.strictEqual(a.text, 'Odnotowane: faktura za październik wystawiona. Następna za listopad, termin <b>poniedziałek 30.11</b> (przypomnę dzień wcześniej).');
  assert.strictEqual(invResolve({}, [{ period: '2026-10', status: 'pending', pings: 3 }]).state.period, '2026-10');
  const none = invResolve({}, [{}], '2026-10-11T12:00:00');
  assert.strictEqual(none.write, false);
  assert.strictEqual(none.text, 'Nie mam otwartej faktury. Najbliższy termin: <b>piątek 30.10</b>, przypomnę dzień wcześniej.');
  assert.strictEqual(invResolve({}, [{}], '2026-10-22T12:00:00').write, false);
  assert.strictEqual(invResolve({}, [{}], '2026-10-23T12:00:00').state.period, '2026-10');
  const dup = invResolve({ invoicePeriod: '2026-10' }, [{ period: '2026-10', status: 'issued' }]);
  assert.deepStrictEqual([dup.write, dup.text], [false, 'Faktura za październik 2026 jest już odhaczona.']);
  assert.strictEqual(invResolve({ invoicePeriod: '2026-13' }, [{ period: '2026-10', status: 'pending' }]).state.period, '2026-10');
});
test('resolve invoice: late September marked while October is still open', () => {
  const o = invResolve({ invoicePeriod: '2026-09' }, [{ period: '2026-09', status: 'pending' }, { period: '2026-10', status: 'pending' }], '2026-10-31T10:00:00');
  assert.strictEqual(o.text, 'Odnotowane: faktura za wrzesień wystawiona.\nNadal otwarte: październik 2026.');
  const n = invResolve({}, [{ period: '2026-10', status: 'pending' }], '2026-11-02T10:00:00');
  assert.strictEqual(n.text, 'Odnotowane: faktura za październik wystawiona. Następna za listopad, termin <b>poniedziałek 30.11</b> (przypomnę dzień wcześniej).');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
