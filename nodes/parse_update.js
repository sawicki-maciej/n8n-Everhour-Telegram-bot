// Turn a Telegram update (text message or button press) into an intent.
// Only the chat from Config.TELEGRAM_CHAT_ID is served; others are ignored.
const ZONE = 'Europe/Warsaw';
const fmtH = (h) => String(Math.round(h * 100) / 100).replace('.', ',');
const cfg = $('Config').first().json; // Config passes the Telegram update through
const allowed = String(cfg.TELEGRAM_CHAT_ID ?? '').trim();
const msg = cfg.message || null;
const cb = cfg.callback_query || null;
const chat = msg ? msg.chat : (cb && cb.message ? cb.message.chat : null);
if (!chat || chat.id === undefined || chat.id === null) return [];
const chatId = String(chat.id);

const base = {
  chatId,
  isCallback: Boolean(cb),
  callbackId: cb ? String(cb.id) : '',
  intent: 'reply',
  status: '',
  date: '',
  until: '',
  hours: 0,
  seconds: 0,
  comment: '',
  text: '',
};
const reply = (text) => [{ json: { ...base, intent: 'reply', text } }];

if (!allowed) {
  return reply(`Bot działa. Twój chat_id: <code>${chatId}</code>\nWpisz go w node Config (pole TELEGRAM_CHAT_ID) i opublikuj workflow.`);
}
if (chatId !== allowed) return [];

const HELP = [
  'Pilnuję godzin w Everhourze. Rano, po południu i wieczorem sprawdzam poprzedni dzień roboczy (pn–pt) i piszę, jeśli czegoś brakuje.',
  '',
  'Odpowiedź na przypomnienie:',
  '• liczba godzin, np. 8, 7,5, 7:30 albo 7h30 (łącznie za dzień; tekst po liczbie trafia do komentarza)',
  '• 0 albo wolne (też urlop, L4): dzień wolny, koniec przypomnień; tekst po nim trafia do notatki, np. „0 L4”',
  '• ok: zostaw jak jest',
  '',
  'Wolne na kilka dni: „0 do piątku”, „L4 do 16.10”, „wolne do jutra”. Liczę od dziś (w odpowiedzi na przypomnienie od jego dnia) i do tego czasu nie przypominam.',
  'wracam: odwołuje zaplanowane wolne od dziś.',
  'Bez przypomnienia też możesz napisać liczbę albo 0, zapytam: dziś czy wczoraj.',
  '',
  'Komendy:',
  '/status: profil Everhoura, ostatnie 7 dni i zaplanowane wolne',
  '/tydzien: godziny w tym tygodniu („/tydzien poprzedni” = zeszły)',
  '/raport: raport miesięczny z Everhoura, domyślnie za poprzedni miesiąc („/raport bieżący”, „/raport 9”, „/raport wrzesień”, „/raport 2026-09”)',
  'wystawiona: faktura za miesiąc odhaczona. Termin to ostatni dzień roboczy miesiąca: przypominam dzień wcześniej, a od terminu do skutku.',
].join('\n');

const lastIso = (s) => {
  const m = String(s || '').match(/\d{4}-\d{2}-\d{2}/g);
  return m ? m[m.length - 1] : '';
};

// Reports: totals come from Everhour's own report endpoints, the bot only picks the date range
const now0 = DateTime.now().setZone(ZONE);
const MONTH_NAMES = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
const dm = (d) => `${d.day}.${String(d.month).padStart(2, '0')}`;
const monthReport = (y, m) => {
  const start = DateTime.fromObject({ year: y, month: m, day: 1 }, { zone: ZONE });
  if (!start.isValid) return reply('Nie rozpoznaję miesiąca.');
  if (start > now0) return reply('Ten miesiąc jeszcze się nie zaczął.');
  return [{
    json: {
      ...base, intent: 'report', reportKind: 'month', from: start.toISODate(), to: start.endOf('month').toISODate(),
      period: `${MONTH_NAMES[m - 1]} ${y}`, running: start.hasSame(now0, 'month'),
    },
  }];
};

if (cb) {
  const [kind, date = '', val = ''] = String(cb.data || '').split('|');
  if (kind === 'off') return [{ json: { ...base, intent: 'mark', status: 'day_off', date, comment: val } }];
  if (kind === 'ok') return [{ json: { ...base, intent: 'mark', status: 'ok', date } }];
  if (kind === 'log') {
    const seconds = Number(val);
    if (!(seconds > 0 && seconds <= 16 * 3600)) return reply('Niepoprawna wartość w przycisku.');
    return [{ json: { ...base, intent: 'log', date, seconds, hours: seconds / 3600 } }];
  }
  if (kind === 'cancel') return reply('OK, nic nie wpisuję.');
  if (kind === 'inv') return [{ json: { ...base, intent: 'invoice', invoicePeriod: date } }];
  if (kind === 'rep') {
    const mm = date.match(/^(\d{4})-(\d{2})$/);
    return mm ? monthReport(Number(mm[1]), Number(mm[2])) : reply('Niepoprawny przycisk raportu.');
  }
  return reply('Nie znam tego przycisku.');
}

const text = typeof msg.text === 'string' ? msg.text.trim() : '';
if (!text) return reply('Obsługuję tylko tekst. Odpisz liczbę godzin, np. 8 albo 7:30.');
const replyDate = msg.reply_to_message ? lastIso(msg.reply_to_message.text) : '';
const cmd = text.toLowerCase().replace(/^(\/[^\s@]+)@\w+/, '$1'); // "/raport@bot 9" -> "/raport 9"

if (/^\/(start|help|pomoc)$/.test(cmd)) return reply(HELP);
if (cmd === '/status') return [{ json: { ...base, intent: 'status' } }];

// Monthly invoice issued: "wystawiona", "wystawiłem", "fv wystawiona" (month from the reminder tag if replying)
if (/^(?:faktura\s+|fv\s+)?(?:wystawiona|wystawione|wystawi[lł]em|wystawi[lł]am)[.!]?$/.test(cmd)) {
  const tagged = msg.reply_to_message ? (String(msg.reply_to_message.text || '').match(/faktura (\d{4}-\d{2})/) || [])[1] : '';
  return [{ json: { ...base, intent: 'invoice', invoicePeriod: tagged || '' } }];
}

const weekCmd = cmd.match(/^\/(?:tydzien|tydzień|tydz|week)(?:\s+(.*))?$/);
if (weekCmd) {
  const arg = String(weekCmd[1] || '').trim();
  if (arg && !/^(poprzedni|zesz[lł]y|ubieg[lł]y|-1)$/.test(arg)) return reply('Użyj <code>/tydzien</code> albo <code>/tydzien poprzedni</code>.');
  const start = now0.startOf('week').minus({ weeks: arg ? 1 : 0 });
  const end = start.plus({ days: 6 });
  return [{ json: { ...base, intent: 'report', reportKind: 'week', from: start.toISODate(), to: end.toISODate(), period: `${dm(start)}–${dm(end)}` } }];
}
const monthCmd = cmd.match(/^\/(?:raport|report|miesiac|miesiąc)(?:\s+(.*))?$/);
if (monthCmd) {
  const a = String(monthCmd[1] || '').trim();
  const prev = now0.minus({ months: 1 });
  const guessYear = (mm) => (mm > now0.month ? now0.year - 1 : now0.year);
  let ym = null;
  let mt;
  if (!a || /^(poprzedni|zesz[lł]y|ubieg[lł]y)$/.test(a)) ym = { y: prev.year, m: prev.month };
  else if (/^(bie[zż][aą]cy|ten|teraz|obecny)$/.test(a)) ym = { y: now0.year, m: now0.month };
  else if ((mt = a.match(/^(\d{4})-(\d{1,2})$/))) ym = { y: Number(mt[1]), m: Number(mt[2]) };
  else if ((mt = a.match(/^(\d{1,2})[./-](\d{4})$/))) ym = { y: Number(mt[2]), m: Number(mt[1]) };
  else if ((mt = a.match(/^(\d{1,2})$/))) ym = { y: guessYear(Number(mt[1])), m: Number(mt[1]) };
  else {
    const n = a.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
    const idx = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paz', 'lis', 'gru'].findIndex((pre) => n.startsWith(pre));
    if (idx >= 0) {
      const yy = (n.match(/(\d{4})/) || [])[1];
      ym = { y: yy ? Number(yy) : guessYear(idx + 1), m: idx + 1 };
    }
  }
  if (!ym || !(ym.m >= 1 && ym.m <= 12)) {
    return reply('Nie rozpoznaję miesiąca. Przykłady: <code>/raport</code> (poprzedni), <code>/raport bieżący</code>, <code>/raport 9</code>, <code>/raport wrzesień</code>, <code>/raport 2026-09</code>.');
  }
  return monthReport(ym.y, ym.m);
}
if (/^(wracam|wróciłem|wrocilem|wróciłam|koniec wolnego)$/.test(cmd)) return [{ json: { ...base, intent: 'resume' } }];

const parseHours = (s) => {
  const v = s.replace(/^(\d+),(\d+)/, '$1.$2'); // decimal comma, leading number only
  let m = v.match(/^(\d{1,2}):([0-5]\d)(?:\s+([\s\S]*))?$/);
  if (m) return { hours: Number(m[1]) + Number(m[2]) / 60, comment: m[3] };
  m = v.match(/^(\d{1,2}(?:\.\d+)?)\s*(?:h|godz\.?|godzin[ay]?)\s*(?:(\d{1,2})\s*(?:m|min\.?)?)?(?:\s+([\s\S]*))?$/i);
  if (m) return { hours: Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0), comment: m[3] };
  m = v.match(/^(\d{2,3})\s*(?:m|min\.?)(?:\s+([\s\S]*))?$/i);
  if (m) return { hours: Number(m[1]) / 60, comment: m[2] };
  m = v.match(/^(\d{1,2}(?:\.\d{1,2})?)(?:\s+([\s\S]*))?$/);
  if (m) return { hours: Number(m[1]), comment: m[2] };
  return null;
};
const OFF_WORD = /^(wolne|urlop|off|l4|chorobowe)(?:\s+([\s\S]*))?$/i;
const isOff = (s) => OFF_WORD.test(s) || (parseHours(s) || {}).hours === 0;

// "do <day>" sets the last day of a day-off range: piątku / pt / jutra / końca tygodnia / 16.10 / 2026-10-16
const now = DateTime.now().setZone(ZONE);
const nextWeekday = (wd) => { let d = now.startOf('day'); while (d.weekday !== wd) d = d.plus({ days: 1 }); return d; };
const WEEKDAYS = [[1, /^(pon|pn)/], [2, /^wt/], [3, /^(sr|śr)/], [4, /^czw/], [5, /^(pi[aą]|pt)/], [6, /^sob/], [7, /^(nd|niedz)/]];
const untilDate = (token) => {
  const t = token.toLowerCase().replace(/\.$/, '');
  if (t === 'jutra') return now.plus({ days: 1 }).startOf('day');
  if (t === 'pojutrza') return now.plus({ days: 2 }).startOf('day');
  if (/^ko[nń]ca\s+tygodnia$/.test(t)) return nextWeekday(5);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return DateTime.fromObject({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, { zone: ZONE });
  m = t.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?$/);
  if (m) {
    const year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : now.year;
    let d = DateTime.fromObject({ year, month: Number(m[2]), day: Number(m[1]) }, { zone: ZONE });
    if (!m[3] && d.isValid && d < now.startOf('day')) d = d.plus({ years: 1 });
    return d;
  }
  for (const [wd, re] of WEEKDAYS) if (re.test(t)) return nextWeekday(wd);
  return null;
};

let body = text;
let until = '';
const um = text.match(/(?:^|\s)do\s+(ko[nń]ca\s+tygodnia|\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|\p{L}+\.?)(?=\s|$)/iu);
if (um) {
  const d = untilDate(um[1]);
  if (d && d.isValid) {
    const rest = `${text.slice(0, um.index)} ${text.slice(um.index + um[0].length)}`.replace(/\s+/g, ' ').trim();
    if (isOff(rest)) {
      body = rest;
      until = d.toISODate();
    } else {
      const ph = parseHours(rest);
      if (ph && ph.hours > 0 && !String(ph.comment || '').trim()) {
        return reply('Godzin nie wpisuję z wyprzedzeniem. Zakres „do …” działa dla wolnego, np. <code>0 do piątku</code> albo <code>L4 do 16.10</code>.');
      }
    }
  }
}

const dayOff = (comment) => [{
  json: { ...base, intent: 'mark', status: 'day_off', date: replyDate, until, comment: String(comment || '').trim().slice(0, 200) },
}];
const offWord = body.match(OFF_WORD);
if (offWord) {
  const tag = { l4: 'L4', urlop: 'urlop', chorobowe: 'chorobowe' }[offWord[1].toLowerCase()] || '';
  return dayOff([tag, String(offWord[2] || '').trim()].filter(Boolean).join(' '));
}
if (/^(ok|okej|okay|zostaw|ok, zostaw)$/.test(cmd)) return [{ json: { ...base, intent: 'mark', status: 'ok', date: replyDate } }];

const p = parseHours(body);
if (!p) {
  return reply('Nie rozumiem. Odpisz liczbę godzin, np. <code>8</code>, <code>7,5</code>, <code>7:30</code> albo <code>7h30</code>. Pomoc: /help');
}
if (p.hours === 0) return dayOff(p.comment); // 0, 0h, 0:00, "0 L4" = day off, nothing goes to Everhour
if (!(p.hours <= 16)) return reply(`${fmtH(p.hours)} h? Maksymalnie 16 h na dzień.`);
const seconds = Math.round(p.hours * 60) * 60;
return [{
  json: { ...base, intent: 'log', date: replyDate, seconds, hours: seconds / 3600, comment: String(p.comment || '').trim().slice(0, 500) },
}];
