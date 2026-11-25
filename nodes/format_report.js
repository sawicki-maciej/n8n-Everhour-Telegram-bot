// /tydzien and /raport. The total is Everhour's own report (GET /dashboards/users, row of this user) as-is:
// the bot never adds time up for it, it only formats seconds. Project lines come from GET /dashboards/projects
// and are shown only when they add up exactly to that total (a consistency check, not a calculation).
// Per-day lines (week only, for curiosity) come from time records and are flagged if they disagree with the report.
const ZONE = 'Europe/Warsaw';
const SHORT = ['pn', 'wt', 'śr', 'cz', 'pt', 'sb', 'nd'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const errText = (res) => {
  if (!res) return 'brak odpowiedzi';
  if (res.error) return String(res.error.message || res.error).slice(0, 200);
  const b = res.body;
  const msg = b && typeof b === 'object' ? (b.message || b.error || JSON.stringify(b)) : String(b ?? '');
  return `HTTP ${res.statusCode ?? '?'}${msg ? ': ' + msg : ''}`.slice(0, 200);
};
const secOf = (v) => Math.round(Number(v) || 0);
const hm = (sec) => {
  const s = secOf(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h} h${m || r ? ` ${String(m).padStart(2, '0')} min` : ''}${r ? ` ${r} s` : ''}`;
};
// decimal hours, shown next to h/min when the total is not a whole hour; "≈" when rounded to 2 places
const dec = (sec) => {
  const v = secOf(sec) / 3600;
  const rounded = Math.round(v * 100) / 100;
  return `${Math.abs(rounded - v) > 1e-9 ? '≈' : ''}${String(rounded).replace('.', ',')} h`;
};
const both = (sec) => (secOf(sec) % 3600 ? `<b>${hm(sec)}</b> (${dec(sec)})` : `<b>${hm(sec)}</b>`);
const fd = (iso) => {
  const d = DateTime.fromISO(iso, { zone: ZONE });
  return `${d.day}.${String(d.month).padStart(2, '0')}`;
};

const r = $('Resolve action').first().json;
const me = $('Everhour: me (report)').first().json;
const users = $('Everhour: users report').first().json;
const projects = $('Everhour: projects report').first().json;
const recs = $('Everhour: time (report)').first().json;
const out = (text) => [{ json: { chatId: r.chatId, text } }];

if (!(me && me.statusCode === 200 && me.body && me.body.id)) {
  return out(`Everhour: nie mogę pobrać profilu (${esc(errText(me))}).`);
}
if (!(users && users.statusCode === 200 && Array.isArray(users.body))) {
  return out(`Everhour nie zwrócił raportu (${esc(errText(users))}). Sumy nie liczę na własną rękę.`);
}
const myId = Number(me.body.id);
const row = users.body.find((u) => u && Number(u.memberId) === myId) || null;
if (!row && users.body.length) {
  // A report came back, but not for this account: never guess a total
  const keys = Object.keys(users.body[0] || {}).slice(0, 12).join(', ');
  return out(`Raport Everhoura nie ma wiersza dla Twojego konta (id ${esc(myId)}). Pola w odpowiedzi: ${esc(keys)}. Sumy nie liczę na własną rękę.`);
}
const total = row ? secOf(row.time) : 0; // empty report = nothing tracked in the period
const month = r.reportKind === 'month';

const lines = [];
lines.push(month
  ? `<b>Raport Everhour: ${esc(r.period)}</b> (${fd(r.from)}–${fd(r.to)}${r.running ? ', miesiąc w toku' : ''})`
  : `<b>Tydzień ${esc(r.period)}</b>`);
lines.push(`Łącznie: ${both(total)}`);
if (row && secOf(row.nonBillableTime) > 0) {
  lines.push(`Billable: ${hm(row.billableTime)}, non-billable: ${hm(row.nonBillableTime)}`);
}
if (row && secOf(row.timeOffTime) > 0) {
  lines.push(`Time off w Everhourze: ${hm(row.timeOffTime)}${Number(row.timeOffDays) ? ` (${esc(row.timeOffDays)} d)` : ''}`);
}

if (projects && projects.statusCode === 200 && Array.isArray(projects.body)) {
  const list = projects.body.filter((x) => x && secOf(x.time) > 0).sort((a, b) => secOf(b.time) - secOf(a.time));
  const check = list.reduce((s, x) => s + secOf(x.time), 0);
  if (list.length && check === total) {
    if (month || list.length > 1) {
      lines.push('', '<b>Projekty</b>');
      for (const x of list) lines.push(`• ${esc(x.projectName || x.projectId)}: ${hm(x.time)}`);
    }
  } else if (list.length && month) {
    lines.push('', 'Rozbicie na projekty pominięte: raport projektów nie zgadza się z sumą.');
  }
} else if (month) {
  lines.push('', `Rozbicie na projekty niedostępne (${esc(errText(projects))}).`);
}

// Week only: per-day view from time records
if (!month) {
  if (recs && recs.statusCode === 200 && Array.isArray(recs.body)) {
    const today = DateTime.now().setZone(ZONE).toISODate();
    const inRange = recs.body.filter((x) => x && typeof x.date === 'string' && x.date >= r.from && x.date <= r.to);
    let off = new Set();
    try {
      off = new Set($('Get pending days').all().map((i) => i.json)
        .filter((x) => x && x.status === 'day_off' && typeof x.date === 'string').map((x) => x.date));
    } catch (e) {
      off = new Set();
    }
    const days = [];
    for (let d = DateTime.fromISO(r.from, { zone: ZONE }); d.toISODate() <= r.to && d.toISODate() <= today; d = d.plus({ days: 1 })) {
      const iso = d.toISODate();
      const sec = inRange.filter((x) => x.date === iso).reduce((s, x) => s + secOf(x.time), 0);
      if (d.weekday > 5 && sec === 0) continue;
      let tag = '';
      if (iso === today) tag = ' (dziś)';
      else if (sec === 0) tag = off.has(iso) ? ' (wolne)' : ' (brak)';
      days.push(`${SHORT[d.weekday - 1]} ${fd(iso)}: ${hm(sec)}${tag}`);
    }
    if (days.length) lines.push('', ...days);
    const daysTotal = inRange.reduce((s, x) => s + secOf(x.time), 0);
    if (daysTotal !== total) lines.push(`Uwaga: wpisy dzienne dają ${hm(daysTotal)}, raport Everhoura ${hm(total)}.`);
  } else {
    lines.push('', `Dni niedostępne (${esc(errText(recs))}).`);
  }
}

if (month) lines.push('', 'Źródło: raport Everhour (dashboards/users), bez przeliczeń po stronie bota.');
return out(lines.join('\n'));
