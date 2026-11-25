// Target = yesterday in Europe/Warsaw. Mon-Fri are workdays, Sat-Sun are off.
// test_now can be pinned on the "Manual test" trigger to simulate a run time.
const ZONE = 'Europe/Warsaw';
const cfg = $('Config').first().json;
const now = cfg.test_now
  ? DateTime.fromISO(String(cfg.test_now), { zone: ZONE })
  : DateTime.now().setZone(ZONE);
// The schedule fires every day at 9:30, 14:00 and 21:30 (invoice reminders need every day).
// The Everhour check keeps its own rhythm: 9:30 Mon-Sat, 14:00 and 21:30 Tue-Sat.
const ehRun = now.hour < 12 ? now.weekday <= 6 : (now.weekday >= 2 && now.weekday <= 6);
if (!ehRun) return [];
const lockDays = Math.max(1, Number(cfg.LOCK_DAYS) || 2);
const target = now.minus({ days: 1 }).startOf('day');

return [{
  json: {
    now: now.toISO(),
    today: now.toISODate(),
    target: target.toISODate(),
    isWorkday: target.weekday <= 5,
    slot: now.hour < 12 ? 'morning' : (now.hour < 18 ? 'afternoon' : 'evening'),
    oldestEditable: now.minus({ days: lockDays - 1 }).toISODate(),
    from: target.minus({ days: 35 }).toISODate(),
  },
}];
