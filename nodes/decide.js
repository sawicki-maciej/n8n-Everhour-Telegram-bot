// Decide what to send for the target day and for pending days that got locked.
// Fail-open: if Everhour cannot be read, remind anyway.
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

const cfg = $('Config').first().json;
const t = $('Compute target day').first().json;
const chatId = String(cfg.TELEGRAM_CHAT_ID ?? '').trim();
if (!chatId) {
  throw new Error('Config: TELEGRAM_CHAT_ID is empty. Send /start to the bot and paste the chat_id into Config.');
}
const MIN = Number(cfg.MIN_HOURS) || 6;
const MAX = Number(cfg.MAX_HOURS) || 10;

// Reminder state (DataTable)
const stateRows = $('Get reminder state').all().map((i) => i.json)
  .filter((r) => r && typeof r.date === 'string' && r.date);
const st = stateRows.find((r) => r.date === t.target) || null;

// Everhour
const meRes = $('Everhour: me (check)').first().json;
const timeRes = $('Everhour: time (check)').first().json;
const meOk = Boolean(meRes && meRes.statusCode === 200 && meRes.body && meRes.body.id);
const ehOk = meOk && Boolean(timeRes && timeRes.statusCode === 200 && Array.isArray(timeRes.body));
const ehError = !meOk ? errText(meRes) : (ehOk ? '' : errText(timeRes));
const records = ehOk ? timeRes.body.filter((r) => r && r.date) : [];
const secondsOn = (iso) => records.filter((r) => r.date === iso).reduce((s, r) => s + (Number(r.time) || 0), 0);
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
const auto = mainTask(records, t.target);
const taskRec = cfgTask ? records.find((r) => r.task && String(r.task.id) === cfgTask) : null;
const taskName = cfgTask ? (taskRec ? taskRec.task.name : cfgTask) : (auto ? auto.name : '');

const out = [];
const DONE = ['logged', 'day_off', 'ok', 'missed'];

// 1) Days still pending that are now outside the edit window
for (const r of stateRows) {
  if (r.status !== 'pending' || r.date >= t.oldestEditable) continue;
  const pings = Number(r.pings) || 0;
  if (r.date < t.from) {
    out.push({ route: 'none', state: { date: r.date, status: 'missed', hours: 0, pings, note: 'stale' } });
    continue;
  }
  if (!ehOk) continue; // verify on a later run
  const sec = secondsOn(r.date);
  if (sec > 0) {
    out.push({ route: 'none', state: { date: r.date, status: 'logged', hours: sec / 3600, pings, note: 'logged outside bot' } });
  } else {
    out.push({
      route: 'plain',
      chatId,
      text: `Everhour: <b>${label(r.date)}</b> został bez godzin, a edycja jest już zablokowana. Poproś administratora Everhoura w firmie o odblokowanie albo dopisanie godzin.`,
      state: { date: r.date, status: 'missed', hours: 0, pings, note: 'locked without entry' },
    });
  }
}

// 2) Target day (yesterday)
if (t.isWorkday && !(st && DONE.includes(st.status))) {
  const pings = st ? Number(st.pings) || 0 : 0;
  const sec = secondsOn(t.target);
  const h = sec / 3600;
  const prefix = t.slot === 'evening' ? 'Ostatnie przypomnienie. ' : (t.slot === 'afternoon' ? 'Przypominam. ' : '');
  const lockLine = t.slot === 'evening' ? 'O północy ten dzień się zablokuje.' : 'Edycja tego dnia działa do dzisiejszej północy.';
  const tag = `\n<code>${t.target}</code>`;
  const day = `<b>${label(t.target)}</b>`;

  if (!ehOk) {
    out.push({
      route: 'button', chatId, buttonText: 'Wolne', buttonData: `off|${t.target}`,
      text: `${prefix}Nie mogę sprawdzić Everhoura (${esc(ehError)}). Upewnij się, że ${day} jest zalogowany. Możesz też odpisać liczbę godzin, spróbuję wpisać.${tag}`,
      state: { date: t.target, status: 'pending', hours: 0, pings: pings + 1, note: 'everhour check failed' },
    });
  } else if (sec === 0) {
    out.push({
      route: 'button', chatId, buttonText: 'Wolne', buttonData: `off|${t.target}`,
      text: `${prefix}Brak godzin w Everhourze za ${day}.\nOdpisz, ile wpisać (np. 8, 7,5 albo 7:30)${taskName ? `, zaloguję na „${esc(taskName)}”` : ''}.\n${lockLine}${tag}`,
      state: { date: t.target, status: 'pending', hours: 0, pings: pings + 1, note: 'missing' },
    });
  } else if (h < MIN || h > MAX) {
    out.push({
      route: 'button', chatId, buttonText: 'OK, zostaw', buttonData: `ok|${t.target}`,
      text: `${prefix}Za ${day} masz w Everhourze ${h < MIN ? 'tylko' : 'aż'} ${fmtH(h)} h.\nJeśli tak ma być, kliknij „OK, zostaw”. Jeśli nie, odpisz łączną liczbę godzin za ten dzień.\n${lockLine}${tag}`,
      state: { date: t.target, status: 'pending', hours: h, pings: pings + 1, note: h < MIN ? 'low' : 'high' },
    });
  } else if (st && st.status === 'pending') {
    out.push({ route: 'none', state: { date: t.target, status: 'logged', hours: h, pings, note: 'logged outside bot' } });
  }
}

return out.map((json) => ({ json }));
