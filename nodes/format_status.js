// /status: Everhour profile timezone + time tracking policy + last 7 days.
// Only selected fields are echoed (the /users/me response also contains the API key).
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
const json = (v, max) => esc(JSON.stringify(v ?? null).slice(0, max));

const r = $('Resolve action').first().json;
const me = $('Everhour: me (status)').first().json;
const tr = $('Everhour: time (status)').first().json;
const now = DateTime.now().setZone(ZONE);

if (!(me && me.statusCode === 200 && me.body && me.body.id)) {
  return [{ json: { chatId: r.chatId, text: `Everhour: nie mogę pobrać profilu (${esc(errText(me))}). Sprawdź klucz API w credentialu.` } }];
}
const u = me.body;
const warsaw = now.offset / 60;
const tz = u.timezone === undefined || u.timezone === null || u.timezone === '' ? null : Number(u.timezone);
const tzText = tz === null || Number.isNaN(tz) ? 'brak' : `UTC${tz >= 0 ? '+' : ''}${tz}`;
const teamBits = {};
if (u.team && typeof u.team === 'object') {
  for (const [k, v] of Object.entries(u.team)) if (/lock|limit|policy|workday|tracking/i.test(k)) teamBits[k] = v;
}

const lines = [
  `<b>Everhour</b>: ${esc(u.name || '')} (id ${esc(u.id)}, rola ${esc(u.role || '?')})`,
  `Strefa w profilu: ${tzText}; Warszawa teraz: UTC+${warsaw}${tz !== null && tz !== warsaw ? ' (różnica!)' : ''}`,
  `Polityka czasu (profil): <code>${json(u.timeTrackingPolicy, 500)}</code>`,
];
if (Object.keys(teamBits).length) lines.push(`Zespół: <code>${json(teamBits, 700)}</code>`);

if (tr && tr.statusCode === 200 && Array.isArray(tr.body)) {
  lines.push('', '<b>Ostatnie 7 dni</b>');
  for (let i = 6; i >= 0; i -= 1) {
    const d = now.minus({ days: i });
    const iso = d.toISODate();
    const sec = tr.body.filter((x) => x && x.date === iso).reduce((s, x) => s + (Number(x.time) || 0), 0);
    lines.push(`${label(iso)}: ${fmtH(sec / 3600)} h${sec === 0 && d.weekday <= 5 && i > 0 ? ' (brak)' : ''}`);
  }
} else {
  lines.push('', `Nie mogę pobrać wpisów (${esc(errText(tr))}).`);
}
let planned = [];
try {
  planned = $('Get pending days').all().map((i) => i.json)
    .filter((x) => x && x.status === 'day_off' && typeof x.date === 'string' && x.date >= now.toISODate())
    .map((x) => x.date).sort();
} catch (e) {
  planned = [];
}
if (planned.length) lines.push('', `<b>Zaplanowane wolne</b>: ${planned.map(label).join(', ')}`);

return [{ json: { chatId: r.chatId, text: lines.join('\n') } }];
