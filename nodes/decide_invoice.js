// Monthly invoice reminder (for contractors billing by the hour). The invoice is due on the last workday (Mon-Fri) of the month.
// Heads-up on the day before at 9:30, then every scheduled run (9:30, 14:00, 21:30) from the due day
// until the month is marked "wystawiona" (text reply or button). State: Data table invoice_reminders.
// Config.INVOICE_REMINDERS = false switches these reminders off.
const ZONE = 'Europe/Warsaw';
const DAYS = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];
const NOM = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const label = (d) => `${DAYS[d.weekday - 1]} ${d.day}.${String(d.month).padStart(2, '0')}`;
const dueDay = (y, m) => {
  let d = DateTime.fromObject({ year: y, month: m, day: 1 }, { zone: ZONE }).endOf('month').startOf('day');
  while (d.weekday > 5) d = d.minus({ days: 1 });
  return d;
};

const cfg = $('Config').first().json;
const chatId = String(cfg.TELEGRAM_CHAT_ID ?? '').trim();
if (!chatId) return [];
if (cfg.INVOICE_REMINDERS === false || String(cfg.INVOICE_REMINDERS).trim().toLowerCase() === 'false') return [];
const now = cfg.test_now
  ? DateTime.fromISO(String(cfg.test_now), { zone: ZONE })
  : DateTime.now().setZone(ZONE);
const today = now.toISODate();
const slot = now.hour < 12 ? 'morning' : (now.hour < 18 ? 'afternoon' : 'evening');
const rows = $('Get invoice rows').all().map((i) => i.json)
  .filter((r) => r && /^\d{4}-\d{2}$/.test(String(r.period || '')));
const byPeriod = new Map(rows.map((r) => [String(r.period), r]));

// Open months: already reminded and not issued, plus the current month from the day before its due day
const periods = new Set(rows.filter((r) => r.status === 'pending').map((r) => String(r.period)));
if (today >= dueDay(now.year, now.month).minus({ days: 1 }).toISODate()) periods.add(now.toFormat('yyyy-MM'));

const out = [];
for (const period of [...periods].sort()) {
  const row = byPeriod.get(period) || null;
  if (row && row.status === 'issued') continue;
  const [y, m] = period.split('-').map(Number);
  const due = dueDay(y, m);
  const dueIso = due.toISODate();
  const eveIso = due.minus({ days: 1 }).toISODate();
  const tag = `\n<code>faktura ${period}</code>`;
  let kind;
  let text;
  if (today < eveIso) continue;
  if (today === eveIso) {
    if (slot !== 'morning') continue;
    kind = 'heads-up';
    text = `Jutro (<b>${label(due)}</b>) ostatni dzień roboczy ${GEN[m - 1]}: faktura za ${NOM[m - 1]}.\nPo wystawieniu kliknij „Wystawiona” albo odpisz „wystawiona”.${tag}`;
  } else if (today === dueIso) {
    kind = 'due';
    text = slot === 'morning'
      ? `Dziś (<b>${label(due)}</b>) ostatni dzień roboczy ${GEN[m - 1]}: wystaw fakturę za ${NOM[m - 1]}.\nNajpierw wpisz dzisiejsze godziny, wtedy raport obejmie cały miesiąc.${tag}`
      : `${slot === 'evening' ? 'Termin mija dziś. ' : 'Przypominam. '}Faktura za ${NOM[m - 1]} czeka na wystawienie.${tag}`;
  } else {
    kind = 'overdue';
    text = `Faktura za ${NOM[m - 1]} nadal niewystawiona (termin: <b>${label(due)}</b>).${tag}`;
  }
  out.push({
    chatId,
    period,
    text,
    reportLabel: `Raport: ${NOM[m - 1]}`,
    reportData: `rep|${period}`,
    doneData: `inv|${period}`,
    state: { period, status: 'pending', pings: (Number(row && row.pings) || 0) + 1, note: kind },
  });
}
return out.map((json) => ({ json }));
