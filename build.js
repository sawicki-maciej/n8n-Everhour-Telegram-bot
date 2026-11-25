// Builds workflow.json (the file you import into n8n) from the Code node sources in nodes/.
// Usage: node build.js
const fs = require('fs');
const path = require('path');

const code = (name) => fs.readFileSync(path.join(__dirname, 'nodes', `${name}.js`), 'utf8');
let _n = 0;
const uid = () => `id${++_n}`;

// Data tables are referenced by name: create them once in n8n (see README).
const DT = { __rl: true, mode: 'name', value: 'everhour_reminders' };
// Credential ids are placeholders: after the import pick your own credentials in n8n.
const EH_CRED = { httpHeaderAuth: { id: 'REPLACE_WITH_YOUR_CREDENTIAL', name: 'Everhour API key' } };
const TG_CRED = { telegramApi: { id: 'REPLACE_WITH_YOUR_CREDENTIAL', name: 'Telegram: Everhour bot' } };
const INV = { __rl: true, mode: 'name', value: 'invoice_reminders' };

const dtSchema = (cols) => cols.map(([id, type]) => ({
  id, displayName: id, required: false, defaultMatch: false, display: true, type, readOnly: false, removed: false,
}));
const ALL_COLS = [['date', 'string'], ['status', 'string'], ['hours', 'number'], ['pings', 'number'], ['note', 'string']];
const INV_COLS = [['period', 'string'], ['status', 'string'], ['pings', 'number'], ['note', 'string']];

const cond = (leftValue, operator, rightValue = '') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [{ id: uid(), leftValue, rightValue, operator }],
  combinator: 'and',
});
const isTrue = (expr) => cond(expr, { type: 'boolean', operation: 'true', singleValue: true }, true);
const routeRule = (key) => ({
  conditions: cond('={{ $json.route }}', { type: 'string', operation: 'equals' }, key),
  renameOutput: true,
  outputKey: key,
});
const routeRuleFixed = (key, id) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id, leftValue: '={{ $json.route }}', rightValue: key, operator: { type: 'string', operation: 'equals' } }],
    combinator: 'and',
  },
  renameOutput: true,
  outputKey: key,
});

const httpOptions = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, timeout: 15000 };
const ehGet = (url, query) => ({
  method: 'GET',
  url,
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendQuery: Boolean(query),
  ...(query ? { specifyQuery: 'keypair', queryParameters: { parameters: query } } : {}),
  sendHeaders: true,
  specifyHeaders: 'keypair',
  headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
  sendBody: false,
  options: httpOptions,
});
const timeQuery = (fromExpr, toExpr) => [
  { name: 'from', value: fromExpr },
  { name: 'to', value: toExpr },
  { name: 'limit', value: '1000' },
];
const tgText = { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true };

const nodes = [];
const add = (name, type, typeVersion, position, parameters, extra = {}) => {
  nodes.push({ id: uid(), name, type, typeVersion, position, parameters, ...extra });
};

// ---------- Setup note
add('Setup', 'n8n-nodes-base.stickyNote', 1, [-480, -520], {
  content: [
    '## Everhour: przypomnienia + logowanie z Telegrama',
    '',
    '**Uruchomienie** (szczegóły w README)',
    '1. Data tables: utwórz **everhour_reminders** (date: string, status: string, hours: number, pings: number, note: string) i **invoice_reminders** (period: string, status: string, pings: number, note: string). Nazwy muszą się zgadzać co do znaku.',
    '2. Credential **Everhour API key** (Header Auth): Name = `X-Api-Key`, Value = klucz API z Everhour (profil użytkownika, na dole strony). Wybierz go we wszystkich node’ach „Everhour: …”.',
    '3. @BotFather → `/newbot` → token wklej w credential Telegram API i wybierz go w node’ach Telegrama.',
    '4. Opublikuj workflow, napisz do bota `/start`, wklej chat_id w **Config** → TELEGRAM_CHAT_ID, opublikuj ponownie.',
    '5. `/status` w bocie: strefa czasowa z profilu Everhour + polityka blokady + ostatnie 7 dni.',
    '',
    '**Config**: MIN_HOURS / MAX_HOURS = zakres, w którym dzień jest „w porządku”; LOCK_DAYS = po ilu dniach Everhour blokuje edycję; EVERHOUR_TASK_ID = task do logowania (puste = task z największą liczbą godzin w ostatnich 14 dniach); INVOICE_REMINDERS = false wyłącza przypomnienia o fakturze.',
    '',
    '**Raporty**: `/tydzien` i `/raport` (domyślnie poprzedni miesiąc). Suma = wiersz użytkownika z Everhour `GET /dashboards/users` bez przeliczeń; projekty z `/dashboards/projects` tylko gdy sumują się do tej wartości. Rozbicie na dni (tylko tydzień) z wpisów czasu.',
    '',
    '**Zasady**: pn–pt robocze, sob–nd wolne. Dzień wolny = „Wolne” / „0” w bocie (też zakres: „0 do piątku”).',
    'Harmonogram (Europe/Warsaw): codziennie 9:30, 14:00 i 21:30. Everhour: 9:30 pn–sob, 14:00 i 21:30 wt–sob; sprawdza wczoraj, w sobotę piątek (w poniedziałek piątek jest już zablokowany).',
    '',
    '**Faktura**: termin = ostatni pn–pt miesiąca. Dzień wcześniej 9:30, od terminu każdy przebieg, aż „wystawiona” (tekst albo przycisk). Stan: Data table **invoice_reminders**.',
    'Stan przypomnień Everhour: Data table **everhour_reminders**.',
  ].join('\n'),
  height: 820,
  width: 680,
  color: 4,
});

// ---------- Triggers + config
add('Schedule', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], {
  rule: {
    interval: [
      { field: 'cronExpression', expression: '30 9 * * *' },
      { field: 'cronExpression', expression: '0 14 * * *' },
      { field: 'cronExpression', expression: '30 21 * * *' },
    ],
  },
});
add('Manual test', 'n8n-nodes-base.manualTrigger', 1, [0, 200], {});
add('Telegram Trigger', 'n8n-nodes-base.telegramTrigger', 1.2, [0, 400], {
  updates: ['message', 'callback_query'],
  additionalFields: {},
}, { webhookId: '5ead4015-5a4f-4814-bd6d-23d08132559c', credentials: TG_CRED });
add('Config', 'n8n-nodes-base.set', 3.4, [240, 200], {
  mode: 'manual',
  includeOtherFields: true,
  include: 'all',
  assignments: {
    assignments: [
      { id: uid(), name: 'TELEGRAM_CHAT_ID', type: 'string', value: '' },
      { id: uid(), name: 'MIN_HOURS', type: 'number', value: 6 },
      { id: uid(), name: 'MAX_HOURS', type: 'number', value: 10 },
      { id: uid(), name: 'LOCK_DAYS', type: 'number', value: 2 },
      { id: uid(), name: 'EVERHOUR_TASK_ID', type: 'string', value: '' },
      { id: uid(), name: 'INVOICE_REMINDERS', type: 'boolean', value: true },
    ],
  },
  options: {},
});
add('Is Telegram update?', 'n8n-nodes-base.if', 2.2, [480, 200], {
  conditions: cond('={{ $json.update_id }}', { type: 'number', operation: 'exists', singleValue: true }),
  options: {},
});

// ---------- Scheduled check
add('Compute target day', 'n8n-nodes-base.code', 2, [720, 0], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('compute_target') });
add('Get reminder state', 'n8n-nodes-base.dataTable', 1.1, [960, 0], {
  resource: 'row',
  operation: 'get',
  dataTableId: DT,
  matchType: 'anyCondition',
  filters: {
    conditions: [
      { keyName: 'date', condition: 'eq', keyValue: '={{ $json.target }}' },
      { keyName: 'status', condition: 'eq', keyValue: 'pending' },
    ],
  },
  returnAll: true,
  orderBy: false,
}, { alwaysOutputData: true });
add('Everhour: me (check)', 'n8n-nodes-base.httpRequest', 4.2, [1200, 0],
  ehGet('https://api.everhour.com/users/me'),
  { credentials: EH_CRED, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Everhour: time (check)', 'n8n-nodes-base.httpRequest', 4.2, [1440, 0],
  ehGet("=https://api.everhour.com/users/{{ $json.body && $json.body.id ? $json.body.id : 'me' }}/time",
    timeQuery("={{ $('Compute target day').first().json.from }}", "={{ $('Compute target day').first().json.target }}")),
  { credentials: EH_CRED, executeOnce: true, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Decide reminders', 'n8n-nodes-base.code', 2, [1680, 0], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('decide') });
add('Save reminder state', 'n8n-nodes-base.dataTable', 1.1, [1920, -140], {
  resource: 'row',
  operation: 'upsert',
  dataTableId: DT,
  matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'date', condition: 'eq', keyValue: '={{ $json.state.date }}' }] },
  columns: {
    mappingMode: 'defineBelow',
    value: {
      date: '={{ $json.state.date }}',
      status: '={{ $json.state.status }}',
      hours: '={{ $json.state.hours }}',
      pings: '={{ $json.state.pings }}',
      note: '={{ $json.state.note }}',
    },
    matchingColumns: [],
    schema: dtSchema(ALL_COLS),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
  options: {},
});
add('Route reminder', 'n8n-nodes-base.switch', 3.2, [1920, 60], {
  mode: 'rules',
  rules: { values: [routeRule('button'), routeRule('plain')] },
  options: {},
});
add('Send reminder', 'n8n-nodes-base.telegram', 1.2, [2160, -20], {
  resource: 'message',
  operation: 'sendMessage',
  chatId: '={{ $json.chatId }}',
  text: '={{ $json.text }}',
  replyMarkup: 'inlineKeyboard',
  inlineKeyboard: {
    rows: [{ row: { buttons: [{ text: '={{ $json.buttonText }}', additionalFields: { callback_data: '={{ $json.buttonData }}' } }] } }],
  },
  additionalFields: tgText,
}, { credentials: TG_CRED });
add('Send notice', 'n8n-nodes-base.telegram', 1.2, [2160, 160], {
  resource: 'message',
  operation: 'sendMessage',
  chatId: '={{ $json.chatId }}',
  text: '={{ $json.text }}',
  replyMarkup: 'none',
  additionalFields: tgText,
}, { credentials: TG_CRED });

// ---------- Telegram bot
add('Parse update', 'n8n-nodes-base.code', 2, [720, 480], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('parse_update') });
add('Is callback?', 'n8n-nodes-base.if', 2.2, [960, 360], { conditions: isTrue('={{ $json.isCallback }}'), options: {} });
add('Answer callback', 'n8n-nodes-base.telegram', 1.2, [1200, 340], {
  resource: 'callback',
  operation: 'answerQuery',
  queryId: '={{ $json.callbackId }}',
  additionalFields: {},
}, { credentials: TG_CRED, onError: 'continueRegularOutput' });
add('Get pending days', 'n8n-nodes-base.dataTable', 1.1, [960, 560], {
  resource: 'row',
  operation: 'get',
  dataTableId: DT,
  matchType: 'anyCondition',
  filters: {
    conditions: [
      { keyName: 'status', condition: 'eq', keyValue: 'pending' },
      { keyName: 'status', condition: 'eq', keyValue: 'day_off' },
    ],
  },
  returnAll: true,
  orderBy: true,
  orderByColumn: 'date',
  orderByDirection: 'DESC',
}, { alwaysOutputData: true });
add('Resolve action', 'n8n-nodes-base.code', 2, [1200, 560], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('resolve_action') });
add('Route action', 'n8n-nodes-base.switch', 3.2, [1440, 560], {
  mode: 'rules',
  rules: { values: [...['log', 'mark', 'ask', 'reply', 'status'].map(routeRule), routeRuleFixed('report', 'id53'), routeRuleFixed('invoice', 'id54')] },
  options: {},
});

// log
add('Everhour: me (log)', 'n8n-nodes-base.httpRequest', 4.2, [1680, 340],
  ehGet('https://api.everhour.com/users/me'),
  { credentials: EH_CRED, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Everhour: time (log)', 'n8n-nodes-base.httpRequest', 4.2, [1920, 340],
  ehGet("=https://api.everhour.com/users/{{ $json.body && $json.body.id ? $json.body.id : 'me' }}/time",
    timeQuery("={{ $('Resolve action').first().json.from }}", "={{ $('Resolve action').first().json.to }}")),
  { credentials: EH_CRED, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Plan time entry', 'n8n-nodes-base.code', 2, [2160, 340], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('plan_entry') });
add('Write needed?', 'n8n-nodes-base.if', 2.2, [2400, 340], { conditions: isTrue('={{ $json.write }}'), options: {} });
add('Everhour: save time', 'n8n-nodes-base.httpRequest', 4.2, [2640, 320], {
  method: '={{ $json.method }}',
  url: '={{ $json.url }}',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendQuery: false,
  sendHeaders: true,
  specifyHeaders: 'keypair',
  headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
  sendBody: true,
  contentType: 'json',
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.body) }}',
  options: httpOptions,
}, { credentials: EH_CRED, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Format log result', 'n8n-nodes-base.code', 2, [2880, 320], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('format_log') });
add('Logged OK?', 'n8n-nodes-base.if', 2.2, [3120, 220], { conditions: isTrue('={{ $json.ok }}'), options: {} });
add('Save logged state', 'n8n-nodes-base.dataTable', 1.1, [3360, 200], {
  resource: 'row',
  operation: 'upsert',
  dataTableId: DT,
  matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'date', condition: 'eq', keyValue: '={{ $json.state.date }}' }] },
  columns: {
    mappingMode: 'defineBelow',
    value: {
      date: '={{ $json.state.date }}',
      status: '={{ $json.state.status }}',
      hours: '={{ $json.state.hours }}',
      note: '={{ $json.state.note }}',
    },
    matchingColumns: [],
    schema: dtSchema(ALL_COLS).map((c) => (c.id === 'pings' ? { ...c, removed: true } : c)),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
  options: {},
});

// mark: one item per day (ranges), then upsert each
add('Split days', 'n8n-nodes-base.splitOut', 1, [1680, 540], { fieldToSplitOut: 'states', include: 'noOtherFields', options: {} });
add('Save marked state', 'n8n-nodes-base.dataTable', 1.1, [1920, 540], {
  resource: 'row',
  operation: 'upsert',
  dataTableId: DT,
  matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'date', condition: 'eq', keyValue: '={{ $json.state.date }}' }] },
  columns: {
    mappingMode: 'defineBelow',
    value: {
      date: '={{ $json.state.date }}',
      status: '={{ $json.state.status }}',
      note: '={{ $json.state.note }}',
    },
    matchingColumns: [],
    schema: dtSchema(ALL_COLS).map((c) => (['hours', 'pings'].includes(c.id) ? { ...c, removed: true } : c)),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
  options: {},
});

// ask
add('Ask which day', 'n8n-nodes-base.telegram', 1.2, [1680, 720], {
  resource: 'message',
  operation: 'sendMessage',
  chatId: '={{ $json.chatId }}',
  text: '={{ $json.text }}',
  replyMarkup: 'inlineKeyboard',
  inlineKeyboard: {
    rows: [
      {
        row: {
          buttons: [
            { text: '={{ $json.todayLabel }}', additionalFields: { callback_data: '={{ $json.todayData }}' } },
            { text: '={{ $json.yesterdayLabel }}', additionalFields: { callback_data: '={{ $json.yesterdayData }}' } },
          ],
        },
      },
      { row: { buttons: [{ text: 'Anuluj', additionalFields: { callback_data: 'cancel' } }] } },
    ],
  },
  additionalFields: tgText,
}, { credentials: TG_CRED });

// status
add('Everhour: me (status)', 'n8n-nodes-base.httpRequest', 4.2, [1680, 900],
  ehGet('https://api.everhour.com/users/me'),
  { credentials: EH_CRED, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Everhour: time (status)', 'n8n-nodes-base.httpRequest', 4.2, [1920, 900],
  ehGet("=https://api.everhour.com/users/{{ $json.body && $json.body.id ? $json.body.id : 'me' }}/time",
    timeQuery("={{ $('Resolve action').first().json.from }}", "={{ $('Resolve action').first().json.to }}")),
  { credentials: EH_CRED, alwaysOutputData: true, onError: 'continueRegularOutput' });
add('Format status', 'n8n-nodes-base.code', 2, [2160, 900], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('format_status') });

// shared reply
add('Send reply', 'n8n-nodes-base.telegram', 1.2, [3360, 560], {
  resource: 'message',
  operation: 'sendMessage',
  chatId: '={{ $json.chatId }}',
  text: '={{ $json.text }}',
  replyMarkup: 'none',
  additionalFields: tgText,
}, { credentials: TG_CRED });

// report: totals straight from Everhour's report endpoints (no summing in n8n)
const RA = "$('Resolve action').first().json";
const ME = "$('Everhour: me (report)').first().json";
const dashQuery = [
  { name: 'date.gte', value: `={{ ${RA}.from }}` },
  { name: 'date.lte', value: `={{ ${RA}.to }}` },
  { name: 'memberId', value: `={{ ${ME}.body && ${ME}.body.id ? ${ME}.body.id : 0 }}` },
];
const ehOpts = { credentials: EH_CRED, alwaysOutputData: true, onError: 'continueRegularOutput' };
add('Everhour: me (report)', 'n8n-nodes-base.httpRequest', 4.2, [1568, 1184], ehGet('https://api.everhour.com/users/me'), ehOpts);
add('Everhour: users report', 'n8n-nodes-base.httpRequest', 4.2, [1792, 1184], ehGet('https://api.everhour.com/dashboards/users', dashQuery), ehOpts);
add('Everhour: projects report', 'n8n-nodes-base.httpRequest', 4.2, [2016, 1184], ehGet('https://api.everhour.com/dashboards/projects', dashQuery), ehOpts);
add('Everhour: time (report)', 'n8n-nodes-base.httpRequest', 4.2, [2240, 1184],
  ehGet(`=https://api.everhour.com/users/{{ ${ME}.body && ${ME}.body.id ? ${ME}.body.id : 'me' }}/time`, timeQuery(`={{ ${RA}.from }}`, `={{ ${RA}.to }}`)),
  ehOpts);
add('Format report', 'n8n-nodes-base.code', 2, [2464, 1184], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('format_report') });

// invoice: scheduled reminders + "wystawiona"
add('Get invoice rows', 'n8n-nodes-base.dataTable', 1.1, [672, -288], {
  resource: 'row', operation: 'get', dataTableId: INV, returnAll: true, orderBy: false,
}, { alwaysOutputData: true });
add('Decide invoice reminder', 'n8n-nodes-base.code', 2, [896, -288], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('decide_invoice') });
const invUpsert = (value, removed) => ({
  resource: 'row',
  operation: 'upsert',
  dataTableId: INV,
  matchType: 'allConditions',
  filters: { conditions: [{ keyName: 'period', condition: 'eq', keyValue: '={{ $json.state.period }}' }] },
  columns: {
    mappingMode: 'defineBelow',
    value,
    matchingColumns: [],
    schema: dtSchema(INV_COLS).map((c) => (removed.includes(c.id) ? { ...c, removed: true } : c)),
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  },
  options: {},
});
add('Save invoice reminder', 'n8n-nodes-base.dataTable', 1.1, [1120, -384], invUpsert({
  period: '={{ $json.state.period }}',
  status: '={{ $json.state.status }}',
  pings: '={{ $json.state.pings }}',
  note: '={{ $json.state.note }}',
}, []));
add('Send invoice reminder', 'n8n-nodes-base.telegram', 1.2, [1120, -192], {
  resource: 'message',
  operation: 'sendMessage',
  chatId: '={{ $json.chatId }}',
  text: '={{ $json.text }}',
  replyMarkup: 'inlineKeyboard',
  inlineKeyboard: {
    rows: [{
      row: {
        buttons: [
          { text: '={{ $json.reportLabel }}', additionalFields: { callback_data: '={{ $json.reportData }}' } },
          { text: 'Wystawiona', additionalFields: { callback_data: '={{ $json.doneData }}' } },
        ],
      },
    }],
  },
  additionalFields: tgText,
}, { credentials: TG_CRED });
add('Get invoice rows (reply)', 'n8n-nodes-base.dataTable', 1.1, [1568, 1376], {
  resource: 'row', operation: 'get', dataTableId: INV, returnAll: true, orderBy: false,
}, { alwaysOutputData: true });
add('Resolve invoice', 'n8n-nodes-base.code', 2, [1792, 1376], { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: code('resolve_invoice') });
add('Invoice to save?', 'n8n-nodes-base.if', 2.2, [2016, 1440], { conditions: isTrue('={{ $json.write }}'), options: {} });
add('Save invoice issued', 'n8n-nodes-base.dataTable', 1.1, [2240, 1440], invUpsert({
  period: '={{ $json.state.period }}',
  status: '={{ $json.state.status }}',
  note: '={{ $json.state.note }}',
}, ['pings']));

// ---------- Connections
const connections = {};
const link = (from, to, out = 0) => {
  connections[from] = connections[from] || { main: [] };
  while (connections[from].main.length <= out) connections[from].main.push([]);
  connections[from].main[out].push({ node: to, type: 'main', index: 0 });
};
link('Schedule', 'Config');
link('Manual test', 'Config');
link('Telegram Trigger', 'Config');
link('Config', 'Is Telegram update?');
link('Is Telegram update?', 'Parse update', 0);
link('Is Telegram update?', 'Compute target day', 1);
link('Compute target day', 'Get reminder state');
link('Get reminder state', 'Everhour: me (check)');
link('Everhour: me (check)', 'Everhour: time (check)');
link('Everhour: time (check)', 'Decide reminders');
link('Decide reminders', 'Save reminder state');
link('Decide reminders', 'Route reminder');
link('Route reminder', 'Send reminder', 0);
link('Route reminder', 'Send notice', 1);
link('Parse update', 'Is callback?');
link('Parse update', 'Get pending days');
link('Is callback?', 'Answer callback', 0);
link('Get pending days', 'Resolve action');
link('Resolve action', 'Route action');
link('Route action', 'Everhour: me (log)', 0);
link('Route action', 'Split days', 1);
link('Split days', 'Save marked state');
link('Route action', 'Send reply', 1);
link('Route action', 'Ask which day', 2);
link('Route action', 'Send reply', 3);
link('Route action', 'Everhour: me (status)', 4);
link('Everhour: me (log)', 'Everhour: time (log)');
link('Everhour: time (log)', 'Plan time entry');
link('Plan time entry', 'Write needed?');
link('Write needed?', 'Everhour: save time', 0);
link('Write needed?', 'Send reply', 1);
link('Everhour: save time', 'Format log result');
link('Format log result', 'Logged OK?');
link('Format log result', 'Send reply');
link('Logged OK?', 'Save logged state', 0);
link('Everhour: me (status)', 'Everhour: time (status)');
link('Everhour: time (status)', 'Format status');
link('Format status', 'Send reply');
link('Route action', 'Everhour: me (report)', 5);
link('Everhour: me (report)', 'Everhour: users report');
link('Everhour: users report', 'Everhour: projects report');
link('Everhour: projects report', 'Everhour: time (report)');
link('Everhour: time (report)', 'Format report');
link('Format report', 'Send reply');
link('Is Telegram update?', 'Get invoice rows', 1);
link('Get invoice rows', 'Decide invoice reminder');
link('Decide invoice reminder', 'Save invoice reminder');
link('Decide invoice reminder', 'Send invoice reminder');
link('Route action', 'Get invoice rows (reply)', 6);
link('Get invoice rows (reply)', 'Resolve invoice');
link('Resolve invoice', 'Invoice to save?');
link('Resolve invoice', 'Send reply');
link('Invoice to save?', 'Save invoice issued', 0);

const workflow = {
  name: 'Everhour Hours Reminder + Telegram Logger',
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    timezone: 'Europe/Warsaw',
    saveManualExecutions: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
  },
};
fs.writeFileSync(path.join(__dirname, 'workflow.json'), JSON.stringify(workflow, null, 2));
console.log(`nodes: ${nodes.length}, bytes: ${JSON.stringify(workflow).length}`);
