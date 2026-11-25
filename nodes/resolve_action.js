// Resolve the day an answer refers to and pick the route.
// Date order: button/reply-to tag > newest pending reminder > ask (today/yesterday).
// Day-off ranges ("0 do piątku") start today, or at the reminder's day when replying to it, and never ask.
const ZONE = 'Europe/Warsaw';
const DAYS = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
const label = (iso) => {
  const d = DateTime.fromISO(iso, { zone: ZONE });
  return `${DAYS[d.weekday - 1]} ${d.day}.${String(d.month).padStart(2, '0')}`;
};
const fmtH = (h) => String(Math.round(h * 100) / 100).replace('.', ',');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Telegram callback_data max 64 bytes: "off|YYYY-MM-DD|" + 12 code points (<= 4 bytes each)
const cbText = (s) => Array.from(String(s || '').replace(/\|/g, '/').trim()).slice(0, 12).join('');
const workdays = (n) => (n === 1 ? 'dzień roboczy' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'dni robocze' : 'dni roboczych'));
const MAX_AHEAD_DAYS = 45;

const p = $('Parse update').first().json;
const cfg = $('Config').first().json;
const now = DateTime.now().setZone(ZONE);
const today = now.toISODate();
const yesterday = now.minus({ days: 1 }).toISODate();
const lockDays = Math.max(1, Number(cfg.LOCK_DAYS) || 2);
const oldest = now.minus({ days: lockDays - 1 }).toISODate();
const rows = $('Get pending days').all().map((i) => i.json).filter((r) => r && typeof r.date === 'string' && r.date);
const pending = rows.filter((r) => r.status === 'pending' && r.date >= oldest && r.date <= today)
  .sort((a, b) => b.date.localeCompare(a.date));
const plannedOff = rows.filter((r) => r.status === 'day_off' && r.date >= today && String(r.note || '').startsWith('telegram'))
  .sort((a, b) => a.date.localeCompare(b.date));
const reply = (text) => [{ json: { ...p, route: 'reply', text } }];

if (p.intent === 'reply') return [{ json: { ...p, route: 'reply' } }];
if (p.intent === 'status') {
  return [{ json: { ...p, route: 'status', from: now.minus({ days: 6 }).toISODate(), to: today } }];
}

if (p.intent === 'report') return [{ json: { ...p, route: 'report' } }];
if (p.intent === 'invoice') return [{ json: { ...p, route: 'invoice' } }];

if (p.intent === 'resume') {
  if (!plannedOff.length) return reply('Nie mam zaplanowanego wolnego, przypominam normalnie.');
  const states = plannedOff.map((r) => ({ state: { date: r.date, status: 'cancelled', note: 'telegram: wracam' } }));
  return [{
    json: { ...p, route: 'mark', states, text: `OK, odwołuję wolne: ${plannedOff.map((r) => label(r.date)).join(', ')}. Przypomnienia wracają.` },
  }];
}

if (p.intent === 'mark' && p.status === 'day_off' && p.until) {
  const start = p.date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(p.until)) return reply('Nie rozpoznaję daty.');
  if (p.until < start) return reply(`<b>${label(p.until)}</b> wypada przed <b>${label(start)}</b>. Podaj późniejszy dzień.`);
  const end = DateTime.fromISO(p.until, { zone: ZONE });
  if (end > now.startOf('day').plus({ days: MAX_AHEAD_DAYS })) return reply(`Maksymalnie ${MAX_AHEAD_DAYS} dni naprzód.`);
  const days = [];
  for (let d = DateTime.fromISO(start, { zone: ZONE }); d <= end; d = d.plus({ days: 1 })) {
    if (d.weekday <= 5) days.push(d.toISODate());
  }
  if (!days.length) return reply('W tym zakresie nie ma dni roboczych.');
  const why = p.comment ? ` (${esc(p.comment)})` : '';
  const note = `telegram: ${p.comment ? `${String(p.comment).slice(0, 150)} ` : ''}do ${p.until}`;
  const states = days.map((date) => ({ state: { date, status: 'day_off', note } }));
  const span = days.length === 1
    ? `<b>${label(days[0])}</b>`
    : `od <b>${label(days[0])}</b> do <b>${label(days[days.length - 1])}</b> (${days.length} ${workdays(days.length)})`;
  const open = pending.filter((r) => r.date < start);
  const openLine = open.length
    ? `\n${open.map((r) => `<b>${label(r.date)}</b>`).join(', ')} nadal czeka na odpowiedź (liczba godzin albo 0).`
    : '';
  return [{ json: { ...p, route: 'mark', states, text: `OK, wolne ${span}${why}. Do tego czasu nie przypominam.${openLine}` } }];
}

const ask = (text, todayData, yesterdayData) => [{
  json: {
    ...p,
    route: 'ask',
    text,
    todayLabel: `Dziś, ${label(today)}`,
    todayData,
    yesterdayLabel: `Wczoraj, ${label(yesterday)}`,
    yesterdayData,
  },
}];

let date = p.date;
if (!date && pending.length) date = pending[0].date;
if (!date) {
  if (p.intent === 'log') {
    return ask(`Za który dzień wpisać ${fmtH(p.hours)} h?`, `log|${today}|${p.seconds}`, `log|${yesterday}|${p.seconds}`);
  }
  if (p.intent === 'mark' && p.status === 'day_off') {
    const c = cbText(p.comment);
    return ask('Który dzień oznaczyć jako wolny?', `off|${today}|${c}`, `off|${yesterday}|${c}`);
  }
  return reply('Nie mam otwartego przypomnienia. Odpowiedz bezpośrednio na wiadomość z datą.');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply('Nie rozpoznaję daty w tej wiadomości.');

if (p.intent === 'mark') {
  const why = p.comment ? ` (${esc(p.comment)})` : '';
  const text = p.status === 'day_off'
    ? `OK, <b>${label(date)}</b> to dzień wolny${why}. Nie przypominam.`
    : `OK, zostawiam <b>${label(date)}</b> bez zmian.`;
  const note = p.comment ? `telegram: ${String(p.comment).slice(0, 200)}` : 'telegram';
  return [{ json: { ...p, date, route: 'mark', text, states: [{ state: { date, status: p.status, note } }] } }];
}

// log
if (date < oldest) {
  return reply(`<b>${label(date)}</b> jest już poza oknem edycji w Everhourze. Poproś administratora Everhoura w firmie o odblokowanie albo dopisanie godzin.`);
}
if (date > today) return reply('Nie wpisuję godzin z wyprzedzeniem.');
return [{
  json: { ...p, date, route: 'log', from: DateTime.fromISO(date, { zone: ZONE }).minus({ days: 45 }).toISODate(), to: date },
}];
