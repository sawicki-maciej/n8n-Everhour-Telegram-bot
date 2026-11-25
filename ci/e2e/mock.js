// Stand-in for the two external services the workflow talks to, used only by the e2e test.
// One HTTPS server answers as api.everhour.com and api.telegram.org (picked by the Host header);
// a plain HTTP control port lets the test seed data and read back every call n8n made.
const fs = require('fs');
const http = require('http');
const https = require('https');

const EVERHOUR_KEY = process.env.MOCK_EVERHOUR_KEY;
const TELEGRAM_TOKEN = process.env.MOCK_TELEGRAM_TOKEN;
const USER = { id: 1001, name: 'Jan Kowalski', role: 'member', timezone: 1, timeTrackingPolicy: { allowTrackingAfterDays: 2 } };
const TASKS = { 'ev:100': { name: 'Development', project: 'Acme' }, 'ev:200': { name: 'Meetings', project: 'Internal' } };

const state = { calls: [], time: [], webhook: null, nextTimeId: 1, nextMessageId: 1 };

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return resolve({});
    try { return resolve(JSON.parse(raw)); } catch (e) { /* not JSON */ }
    return resolve(Object.fromEntries(new URLSearchParams(raw)));
  });
});
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const record = (t) => ({ id: t.id, date: t.date, time: t.time, user: USER.id, comment: t.comment, task: { id: t.task, name: (TASKS[t.task] || {}).name || t.task } });
const inRange = (from, to) => state.time.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));

function everhour(req, res, url, body) {
  if (req.headers['x-api-key'] !== EVERHOUR_KEY) return send(res, 401, { code: 401, message: 'Invalid API key' });
  const q = url.searchParams;
  if (req.method === 'GET' && url.pathname === '/users/me') return send(res, 200, { ...USER, apiKey: EVERHOUR_KEY });
  if (req.method === 'GET' && url.pathname === `/users/${USER.id}/time`) return send(res, 200, inRange(q.get('from'), q.get('to')).map(record));
  if (req.method === 'POST' && url.pathname === '/time') {
    const t = { id: state.nextTimeId++, task: String(body.task), date: String(body.date), time: Number(body.time), comment: body.comment };
    state.time.push(t);
    return send(res, 201, record(t));
  }
  const put = url.pathname.match(/^\/time\/(\d+)$/);
  if (req.method === 'PUT' && put) {
    const t = state.time.find((x) => x.id === Number(put[1]));
    if (!t) return send(res, 404, { code: 404, message: 'Not found' });
    t.time = Number(body.time);
    if (body.comment !== undefined) t.comment = body.comment;
    return send(res, 200, record(t));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/dashboards/')) {
    const rows = inRange(q.get('date.gte'), q.get('date.lte'));
    const total = rows.reduce((s, t) => s + t.time, 0);
    if (url.pathname === '/dashboards/users') {
      return send(res, 200, total ? [{ memberId: USER.id, memberName: USER.name, time: total, billableTime: total, nonBillableTime: 0, timeOffTime: 0, timeOffDays: 0 }] : []);
    }
    if (url.pathname === '/dashboards/projects') {
      const by = new Map();
      for (const t of rows) {
        const name = (TASKS[t.task] || {}).project || 'Other';
        by.set(name, (by.get(name) || 0) + t.time);
      }
      return send(res, 200, [...by].map(([projectName, time]) => ({ projectId: projectName, projectName, time })));
    }
  }
  return send(res, 404, { code: 404, message: `mock: no route ${req.method} ${url.pathname}` });
}

function telegram(req, res, url, body) {
  const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
  if (!m) return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
  if (m[1] !== TELEGRAM_TOKEN) return send(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
  const method = m[2];
  const args = { ...Object.fromEntries(url.searchParams), ...body };
  if (method === 'getMe') return send(res, 200, { ok: true, result: { id: 42, is_bot: true, first_name: 'Test bot', username: 'test_bot' } });
  if (method === 'setWebhook') { state.webhook = args; return send(res, 200, { ok: true, result: true }); }
  if (method === 'deleteWebhook') { state.webhook = null; return send(res, 200, { ok: true, result: true }); }
  if (method === 'getWebhookInfo') return send(res, 200, { ok: true, result: { url: state.webhook ? state.webhook.url : '' } });
  if (method === 'sendMessage') {
    return send(res, 200, { ok: true, result: { message_id: state.nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(args.chat_id), type: 'private' }, text: args.text } });
  }
  if (method === 'answerCallbackQuery') return send(res, 200, { ok: true, result: true });
  return send(res, 404, { ok: false, error_code: 404, description: `mock: no method ${method}` });
}

https.createServer({ key: fs.readFileSync('/certs/server.key'), cert: fs.readFileSync('/certs/server.crt') }, async (req, res) => {
  const host = String(req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  const body = await readBody(req);
  const api = host === 'api.everhour.com' ? 'everhour' : (host === 'api.telegram.org' ? 'telegram' : host);
  // Telegram: keep the method name, never the token
  const path = api === 'telegram' ? url.pathname.replace(/^\/bot[^/]+/, '') : url.pathname;
  state.calls.push({ seq: state.calls.length + 1, api, method: req.method, path, query: Object.fromEntries(url.searchParams), body });
  if (api === 'everhour') return everhour(req, res, url, body);
  if (api === 'telegram') return telegram(req, res, url, body);
  return send(res, 502, { message: `mock: unexpected host ${host}` });
}).listen(443);

http.createServer(async (req, res) => {
  const body = await readBody(req);
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && req.url === '/state') return send(res, 200, { calls: state.calls, time: state.time.map(record), webhook: state.webhook });
  if (req.method === 'POST' && req.url === '/seed') {
    state.time = (body.time || []).map((t) => ({ id: state.nextTimeId++, ...t }));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { message: 'mock control: no route' });
}).listen(8080);
