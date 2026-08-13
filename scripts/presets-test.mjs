/**
 * Перевірка пресетів і того, як вони лягають на хвилинну сітку.
 *
 *   node scripts/presets-test.mjs
 */
import {
  MODES,
  TEMPOS,
  DEFAULT_MODE,
  DEFAULT_TEMPO,
  modeThresholds,
  reactionSeconds,
  resolveMode,
  resolveTempo,
  tempoSeconds,
} from '../lib/presets.js';
import { runSweeps } from '../lib/sweep.js';

const BUDGET_MS = 55_000; // MAX_RUN_SECONDS
const PROBE_MS = 4_000; // PROBE_TIMEOUT, одна спроба — найдовший можливий прохід
const CRON_MS = 60_000; // cron приходить щохвилини

let failures = 0;

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '✅' : '❌'} ${label}` +
      (ok ? '' : `\n   отримав:  ${JSON.stringify(actual)}\n   очікував: ${JSON.stringify(expected)}`)
  );
}

// --- розпізнавання назв ------------------------------------------------------

expect('за назвою', resolveMode('спокійний'), 'спокійний');
expect('за номером', resolveMode('3'), 'спокійний');
expect('регістр не важливий', resolveMode('СПОКІЙНИЙ'), 'спокійний');
expect('пробіли не важливі', resolveMode('  швидкий '), 'швидкий');
expect('порожньо — типовий', resolveMode(''), DEFAULT_MODE);
expect('нісенітниця — відмова', resolveMode('дуже швидкий'), null);
expect('номер поза списком — відмова', resolveMode('9'), null);
expect('темп за номером', resolveTempo('1'), 'частий');
expect('темп за назвою', resolveTempo('економний'), 'економний');

// --- відсутнє чи зіпсоване значення не ламає бота ----------------------------

expect('невідомий режим — типові пороги', modeThresholds('вигаданий'), MODES[DEFAULT_MODE]);
expect('нічого не обрано — типові пороги', modeThresholds(undefined), MODES[DEFAULT_MODE]);
expect('невідомий темп — типовий крок', tempoSeconds('вигаданий'), TEMPOS[DEFAULT_TEMPO].seconds);

// --- обіцянки з таблиці у довідці -------------------------------------------

expect('швидкий на звичайному темпі — 30 с', reactionSeconds('швидкий', 'звичайний'), 30);
expect('звичайний на звичайному — 60 с', reactionSeconds('звичайний', 'звичайний'), 60);
expect('спокійний на звичайному — 120 с', reactionSeconds('спокійний', 'звичайний'), 120);

// --- кожен темп має ділити хвилину націло ------------------------------------

for (const [name, preset] of Object.entries(TEMPOS)) {
  expect(`темп «${name}» (${preset.seconds} с) ділить 60 націло`, 60 % preset.seconds, 0);
  expect(
    `невдалий прохід укладається в крок «${name}»`,
    PROBE_MS <= preset.seconds * 1000,
    true
  );
}

// --- сітка не рветься на стику хвилин ----------------------------------------

function fakeClock() {
  let current = 0;
  return { now: () => current, sleep: async (ms) => { current += ms; }, advance: (ms) => { current += ms; } };
}

async function grid(intervalMs, workMs) {
  const clock = fakeClock();
  const offsets = [];
  await runSweeps({
    intervalMs,
    budgetMs: BUDGET_MS,
    now: clock.now,
    sleep: clock.sleep,
    run: async () => {
      offsets.push(clock.now());
      clock.advance(workMs);
      return { devices: 1 };
    },
  });
  return offsets;
}

for (const [name, preset] of Object.entries(TEMPOS)) {
  const step = preset.seconds * 1000;

  // Найгірший випадок: усі адреси мовчать, кожен прохід триває цілий таймаут.
  const worst = await grid(step, PROBE_MS);
  const gap = CRON_MS - worst.at(-1);
  expect(
    `«${name}»: розрив на стику хвилин дорівнює кроку навіть коли все мовчить`,
    gap,
    step
  );

  // Звичайний випадок: адреси відповідають швидко.
  const healthy = await grid(step, 150);
  expect(`«${name}»: та сама сітка на живих адресах`, healthy, worst);
  expect(
    `«${name}»: проходів за виклик — ${60 / preset.seconds}`,
    worst.length,
    60 / preset.seconds
  );
}

console.log(failures === 0 ? '\nВсе зійшлось.' : `\nПровалів: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
