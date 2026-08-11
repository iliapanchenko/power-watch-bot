/**
 * Прогін розкладки проходів на фейковому годиннику: хвилина роботи
 * перевіряється за мілісекунди.
 *
 *   node scripts/sweep-test.mjs
 */
import { runSweeps } from '../lib/sweep.js';

/** Віртуальний час: sleep не чекає, а просто перемотує годинник уперед. */
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

let failures = 0;

async function scenario(label, { intervalMs, budgetMs, once, workMs, sweepLimit = 99 }) {
  const clock = fakeClock();
  const offsets = [];

  await runSweeps({
    intervalMs,
    budgetMs,
    once,
    now: clock.now,
    sleep: clock.sleep,
    shouldStop: () => offsets.length >= sweepLimit,
    run: async () => {
      offsets.push(clock.now());
      clock.advance(workMs); // імітуємо час самої перевірки
      return { checked: 1 };
    },
  });

  return { label, offsets, finishedAt: clock.now() };
}

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '✅' : '❌'} ${label}\n   отримав:  ${JSON.stringify(actual)}` +
      (ok ? '' : `\n   очікував: ${JSON.stringify(expected)}`)
  );
}

// Бойові налаштування: крок 15 с, бюджет 55 с, перевірка триває 1 с.
const normal = await scenario('типовий прогін', {
  intervalMs: 15000,
  budgetMs: 55000,
  workMs: 1000,
});
expect('проходи стоять на сітці 0/15/30/45 с', normal.offsets, [0, 15000, 30000, 45000]);
expect('вкладається в бюджет 55 с', normal.finishedAt <= 55000, true);

// Повільні перевірки не мають зсувати сітку.
const slow = await scenario('повільні перевірки (8 с кожна)', {
  intervalMs: 15000,
  budgetMs: 55000,
  workMs: 8000,
});
expect('сітка не поїхала', slow.offsets, [0, 15000, 30000, 45000]);

// Перевірка довша за крок: проходи йдуть підряд, без накладань.
// Третій не запускається: він стартував би о 40 с і закінчився о 60 с,
// тобто виліз би за бюджет і потрапив під таймаут платформи.
const overrun = await scenario('перевірка довша за крок (20 с)', {
  intervalMs: 15000,
  budgetMs: 55000,
  workMs: 20000,
});
expect('проходи не накладаються і не вилазять за бюджет', overrun.offsets, [0, 20000]);
expect('прогін завершився в межах бюджету', overrun.finishedAt <= 55000, true);

// Дуже повільні перевірки: краще один прохід, ніж обірваний другий.
const verySlow = await scenario('дуже повільні перевірки (50 с)', {
  intervalMs: 15000,
  budgetMs: 55000,
  workMs: 50000,
});
expect('один прохід', verySlow.offsets, [0]);

// ?once=1 — рівно один прохід.
const single = await scenario('режим once', {
  intervalMs: 15000,
  budgetMs: 55000,
  once: true,
  workMs: 1000,
});
expect('рівно один прохід', single.offsets, [0]);

// Крок 30 с.
const half = await scenario('крок 30 с', {
  intervalMs: 30000,
  budgetMs: 55000,
  workMs: 1000,
});
expect('два проходи: 0 і 30 с', half.offsets, [0, 30000]);

// Стик хвилин: останній прохід о 45 с, наступний виклик стартує о 60 с.
const gap = 60000 - normal.offsets.at(-1);
expect('розрив на межі хвилини теж 15 с', gap, 15000);

console.log(failures === 0 ? '\nВсе зійшлось.' : `\nПровалів: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
