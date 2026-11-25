// "wystawiona" (text, reply to a reminder, or the button): mark the invoice for a month as issued.
// Month: button / reply tag > oldest month still being reminded > current month in its last week before the due day.
const ZONE = 'Europe/Warsaw';
const DAYS = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
const NOM = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const label = (d) => `${DAYS[d.weekday - 1]} ${d.day}.${String(d.month).padStart(2, '0')}`;
const dueDay = (y, m) => {
  let d = DateTime.fromObject({ year: y, month: m, day: 1 }, { zone: ZONE }).endOf('month').startOf('day');
  while (d.weekday > 5) d = d.minus({ days: 1 });
  return d;
};
const monthName = (period) => `${NOM[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`;

const p = $('Resolve action').first().json;
const now = DateTime.now().setZone(ZONE);
const today = now.toISODate();
const rows = $('Get invoice rows (reply)').all().map((i) => i.json)
  .filter((r) => r && /^\d{4}-\d{2}$/.test(String(r.period || '')));
const byPeriod = new Map(rows.map((r) => [String(r.period), r]));
const pending = rows.filter((r) => r.status === 'pending').map((r) => String(r.period)).sort();
const reply = (text) => [{ json: { chatId: p.chatId, text, write: false } }];

let period = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p.invoicePeriod || '')) ? String(p.invoicePeriod) : '';
if (!period && pending.length) period = pending[0];
if (!period) {
  const due = dueDay(now.year, now.month);
  if (today < due.minus({ days: 7 }).toISODate()) {
    return reply(`Nie mam otwartej faktury. Najbliższy termin: <b>${label(due)}</b>, przypomnę dzień wcześniej.`);
  }
  period = now.toFormat('yyyy-MM'); // issued early, in the last week before the due day
}
const [y, m] = period.split('-').map(Number);
const row = byPeriod.get(period) || null;
if (row && row.status === 'issued') return reply(`Faktura za ${NOM[m - 1]} ${y} jest już odhaczona.`);

// Next month that still needs an invoice, counted from the current month
const issued = new Set(rows.filter((r) => r.status === 'issued').map((r) => String(r.period)));
issued.add(period);
let n = now.startOf('month');
while (issued.has(n.toFormat('yyyy-MM'))) n = n.plus({ months: 1 });
const nextDue = dueDay(n.year, n.month);
const nextLine = nextDue.toISODate() >= today
  ? ` Następna za ${NOM[n.month - 1]}, termin <b>${label(nextDue)}</b> (przypomnę dzień wcześniej).`
  : '';
const others = pending.filter((x) => x !== period);
const otherLine = others.length ? `\nNadal otwarte: ${others.map(monthName).join(', ')}.` : '';

return [{
  json: {
    chatId: p.chatId,
    write: true,
    text: `Odnotowane: faktura za ${NOM[m - 1]} wystawiona.${nextLine}${otherLine}`,
    state: { period, status: 'issued', note: 'telegram' },
  },
}];
