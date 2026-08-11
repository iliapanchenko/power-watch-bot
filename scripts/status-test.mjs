/**
 * Перевірка логіки станів на вигаданому годиннику.
 *
 *   node scripts/status-test.mjs
 */
import { applyProbe, closeDay, emptyState } from '../lib/status.js';
import { humanDuration, humanDurationOrZero } from '../lib/format.js';

const T = { failThreshold: 2, okThreshold: 2 };
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

let failures = 0;

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '✅' : '❌'} ${label}` +
      (ok ? '' : `\n   отримав:  ${JSON.stringify(actual)}\n   очікував: ${JSON.stringify(expected)}`)
  );
}

/** Прогнати послідовність проб: true = відповіла, false = тиша. */
function play(probes, { state = emptyState(), start = 0, step = 15 * SEC } = {}) {
  const events = [];
  let current = state;
  let clock = start;

  for (const alive of probes) {
    const result = applyProbe(current, alive, clock, T);
    current = result.state;
    if (result.transition) events.push({ at: clock, ...result.transition });
    clock += step;
  }
  return { state: current, events, clock };
}

// --- гістерезис -------------------------------------------------------------

const firstContact = play([true, true]);
expect('перший вихід на зв\'язок не є подією', firstContact.events, []);
expect('але статус став up', firstContact.state.status, 'up');

const oneMiss = play([true, true, false]);
expect('одна тиша статус не міняє', oneMiss.state.status, 'up');
expect('і нікого не будить', oneMiss.events.length, 1 - 1);

const realOutage = play([true, true, false, false]);
expect('дві тиші поспіль = світло зникло', realOutage.state.status, 'down');
expect('подія рівно одна', realOutage.events.length, 1);
expect('це саме «зникло»', realOutage.events[0].to, 'down');

const flapping = play([true, true, false, true, false, true, false]);
expect('миготіння через одну пробу статус не рухає', flapping.state.status, 'up');
expect('і не породжує подій', flapping.events.length, 0);

// --- тривалості -------------------------------------------------------------

// Світло є з нуля, зникає, за годину повертається.
const cycle = play([true, true, false, false], { step: 15 * SEC });
const afterOutage = play([false, false, true, true], {
  state: cycle.state,
  start: cycle.clock + HOUR,
  step: 15 * SEC,
});

expect('повернення світла — одна подія', afterOutage.events.length, 1);
expect('і це «з\'явилось»', afterOutage.events[0].to, 'up');
expect(
  'тривалість відключення близько години',
  Math.round(afterOutage.events[0].durationSec / 60),
  Math.round((HOUR + 45 * SEC) / MIN)
);
expect(
  'година пішла в добовий лічильник',
  Math.round(afterOutage.state.downToday / 60),
  Math.round((HOUR + 45 * SEC) / MIN)
);
expect('поточного відключення більше немає', afterOutage.state.downSince, null);

// --- підсумок доби ----------------------------------------------------------

const quietDay = closeDay({ ...emptyState(), status: 'up', downToday: 0 }, 0);
expect('день без відключень — нуль', quietDay.downSec, 0);

const midnight = 10 * HOUR;
const stillDark = closeDay(
  {
    ...emptyState(),
    status: 'down',
    statusSince: midnight - 3 * HOUR,
    downSince: midnight - 3 * HOUR,
    downToday: 2 * HOUR / SEC,
  },
  midnight
);
expect(
  'триваюче відключення ріжеться по межі доби: 2 год раніше + 3 год зараз',
  stillDark.downSec / 3600,
  5
);
expect('лічильник обнулився', stillDark.state.downToday, 0);
expect('відлік нового дня почався з півночі', stillDark.state.downSince, midnight);

const nextDay = play([false, false, true, true], {
  state: stillDark.state,
  start: midnight + HOUR,
  step: 15 * SEC,
});
expect(
  'у новий день пішла тільки його частина, а не всі 6 годин',
  Math.round(nextDay.state.downToday / 3600),
  1
);

// --- баланс доби: було + не було = під наглядом -----------------------------

const fullDay = closeDay(
  {
    ...emptyState(),
    status: 'up',
    dayStart: 24 * HOUR,
    downToday: (2 * HOUR) / SEC,
  },
  48 * HOUR
);
expect('за добу без світла було 2 години', fullDay.downSec / 3600, 2);
expect('решта доби — зі світлом', fullDay.upSec / 3600, 22);
expect('сума сходиться з часом під наглядом', fullDay.upSec + fullDay.downSec, fullDay.trackedSec);

// Точку додали ополудні — вигаданої темряви за ранок бути не повинно.
const partial = closeDay(
  { ...emptyState(), status: 'up', dayStart: 45 * HOUR, downToday: 0 },
  48 * HOUR
);
expect('неповна перша доба рахується від моменту додавання', partial.upSec / 3600, 3);
expect('і жодної вигаданої темряви', partial.downSec, 0);
expect('новий день відлічується від підсумку', partial.state.dayStart, 48 * HOUR);

// --- слова й відмінки -------------------------------------------------------

const durations = [
  [30, 'менше хвилини'],
  [60, '1 хвилину'],
  [120, '2 хвилини'],
  [300, '5 хвилин'],
  [21 * 60, '21 хвилину'],
  [11 * 60, '11 хвилин'],
  [HOUR / SEC, '1 годину'],
  [(2 * HOUR) / SEC, '2 години'],
  [(5 * HOUR) / SEC, '5 годин'],
  [(11 * HOUR) / SEC, '11 годин'],
  [(21 * HOUR + 35 * MIN) / SEC, '21 годину 35 хвилин'],
  [86400, '1 день'],
  [2 * 86400, '2 дні'],
  [5 * 86400, '5 днів'],
  [53 * 86400 + 9 * 3600 + 55 * 60, '53 дні 9 годин 55 хвилин'],
];

for (const [seconds, want] of durations) {
  expect(`${seconds} с -> «${want}»`, humanDuration(seconds), want);
}

expect('нуль у звіті — «0 хвилин»', humanDurationOrZero(0), '0 хвилин');
expect('півхвилини у звіті теж «0 хвилин»', humanDurationOrZero(30), '0 хвилин');

// --- лічильники не ростуть безмежно ----------------------------------------

const longUptime = play(Array(500).fill(true));
expect('лічильник ok впирається в поріг', longUptime.state.ok, T.okThreshold);
const longOutage = play(Array(500).fill(false));
expect('лічильник fail впирається в поріг', longOutage.state.fail, T.failThreshold);

console.log(failures === 0 ? '\nВсе зійшлось.' : `\nПровалів: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
