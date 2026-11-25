// Plan the Everhour write so the day total equals the answered value.
// Task: Config.EVERHOUR_TASK_ID, or the task with the most time in the 14 days before the day.
const ZONE = 'Europe/Warsaw';
const DAYS = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const label = (iso) => {
  const d = DateTime.fromISO(iso, { zone: ZONE });
  return `${DAYS[d.weekday - 1]} ${d.day}.${String(d.month).padStart(2, '0')}`;
};
const fmtH = (h) => String(Math.round(h * 100) / 100).replace('.', ',');
const errText = (res) => {
  if (!res) return 'brak odpowiedzi';
  if (res.error) return String(res.error.message || res.error).slice(0, 200);
  const b = res.body;
  const msg = b && typeof b === 'object' ? (b.message || b.error || JSON.stringify(b)) : String(b ?? '');
  return `HTTP ${res.statusCode ?? '?'}${msg ? ': ' + msg : ''}`.slice(0, 200);
};

const r = $('Resolve action').first().json;
const cfg = $('Config').first().json;
const me = $('Everhour: me (log)').first().json;
const tr = $('Everhour: time (log)').first().json;
const reply = (text) => [{ json: { chatId: r.chatId, write: false, text } }];

if (!(me && me.statusCode === 200 && me.body && me.body.id)) {
  return reply(`Everhour: nie mogę pobrać profilu (${esc(errText(me))}). Sprawdź klucz API w credentialu.`);
}
if (!(tr && tr.statusCode === 200 && Array.isArray(tr.body))) {
  return reply(`Everhour: nie mogę pobrać wpisów (${esc(errText(tr))}).`);
}

const userId = me.body.id;
const records = tr.body.filter((x) => x && x.date);
const day = records.filter((x) => x.date === r.date);
const total = day.reduce((s, x) => s + (Number(x.time) || 0), 0);
const cfgTask = String(cfg.EVERHOUR_TASK_ID ?? '').trim();
// Main task = most time in the 14 days before the day (one-off HR/meeting entries do not win)
const mainTask = (list, beforeIso) => {
  const since = DateTime.fromISO(beforeIso, { zone: ZONE }).minus({ days: 14 }).toISODate();
  const withTask = list.filter((x) => x.task && x.task.id);
  const recent = withTask.filter((x) => String(x.date) >= since);
  const totals = new Map();
  for (const x of (recent.length ? recent : withTask)) {
    const id = String(x.task.id);
    const e = totals.get(id) || { id, name: x.task.name, sec: 0, last: '' };
    e.sec += Number(x.time) || 0;
    if (String(x.date) > e.last) e.last = String(x.date);
    totals.set(id, e);
  }
  return [...totals.values()].sort((a, b) => b.sec - a.sec || b.last.localeCompare(a.last))[0] || null;
};
const auto = mainTask(records, r.date);
const taskId = cfgTask || (auto ? auto.id : '');
if (!taskId) {
  return reply('Nie wiem, na który task logować (brak wpisów z ostatnich 45 dni). Wpisz EVERHOUR_TASK_ID w node Config.');
}
const taskRec = records.find((x) => x.task && String(x.task.id) === taskId);
const taskName = taskRec ? taskRec.task.name : taskId;
const onTask = day.filter((x) => x.task && String(x.task.id) === taskId);
const onTaskSec = onTask.reduce((s, x) => s + (Number(x.time) || 0), 0);
const other = total - onTaskSec;
const desired = Number(r.seconds);
const newTaskTime = desired - other;

if (desired === total) return reply(`Za <b>${label(r.date)}</b> jest już ${fmtH(total / 3600)} h. Nic nie zmieniam.`);
if (newTaskTime <= 0) {
  return reply(`Za <b>${label(r.date)}</b> masz już ${fmtH(other / 3600)} h na innych taskach. Popraw ręcznie w Everhourze.`);
}
if (onTask.length > 1) return reply(`Za <b>${label(r.date)}</b> ten task ma kilka wpisów. Popraw ręcznie w Everhourze.`);

const existing = onTask[0] || null;
const comment = r.comment || (existing && existing.comment) || '';
const body = existing
  ? { time: newTaskTime, ...(comment ? { comment } : {}) }
  : { task: taskId, user: userId, date: r.date, time: newTaskTime, ...(comment ? { comment } : {}) };

return [{
  json: {
    chatId: r.chatId,
    write: true,
    method: existing ? 'PUT' : 'POST',
    url: existing ? `https://api.everhour.com/time/${existing.id}` : 'https://api.everhour.com/time',
    body,
    date: r.date,
    desired,
    other,
    previous: total,
    taskName,
  },
}];
