// Confirmation message after the Everhour write.
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

const plan = $('Plan time entry').first().json;
const res = $('Everhour: save time').first().json;
const ok = Boolean(res && res.statusCode >= 200 && res.statusCode < 300);
if (!ok) {
  return [{ json: { chatId: plan.chatId, ok: false, text: `Everhour odrzucił wpis za <b>${label(plan.date)}</b> (${esc(errText(res))}).` } }];
}
const saved = (res.body && Number(res.body.time)) || Number(plan.body.time);
const hours = (plan.other + saved) / 3600;
const prev = plan.previous ? ` (było ${fmtH(plan.previous / 3600)} h)` : '';
return [{
  json: {
    chatId: plan.chatId,
    ok: true,
    text: `Zapisane: <b>${fmtH(hours)} h</b> za ${label(plan.date)}${prev}, task „${esc(plan.taskName)}”.`,
    state: { date: plan.date, status: 'logged', hours, note: 'telegram' },
  },
}];
