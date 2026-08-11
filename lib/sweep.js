const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Кілька проходів усередині одного виклику функції.
 *
 * Проходи прив'язані до сітки від старту (0, 15, 30, 45 с), а не до моменту
 * завершення попереднього. Інакше повільна перевірка зсувала б увесь розклад,
 * і до кінця хвилини крок розповзався б.
 *
 * Годинник і пауза приходять параметрами, щоб тест міг прогнати хвилину
 * за мілісекунди.
 *
 * @param {object} options
 * @param {(index: number) => Promise<any>} options.run   що робити за прохід
 * @param {number} options.intervalMs                     крок сітки
 * @param {number} options.budgetMs                       скільки часу всього є
 * @param {boolean} [options.once]                        зупинитись після першого
 * @param {(result: any) => boolean} [options.shouldStop] достроково вийти
 * @returns {Promise<any[]>} результати проходів
 */
export async function runSweeps({
  run,
  intervalMs,
  budgetMs,
  once = false,
  shouldStop = () => false,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const startedAt = now();
  const results = [];

  for (let index = 0; ; index += 1) {
    const sweepStartedAt = now();
    const result = await run(index);
    results.push(result);

    if (once || shouldStop(result)) break;

    const lastDuration = now() - sweepStartedAt;
    // Якщо прохід виявився довшим за крок, наступний починаємо одразу,
    // а не в минулому.
    const nextStart = Math.max(startedAt + (index + 1) * intervalMs, now());

    // Рішення приймається за фактичним часом, а не за номером проходу:
    // інакше кілька повільних перевірок підряд винесли б нас за бюджет,
    // і платформа вбила б функцію посеред роботи. Наступний прохід
    // запускаємо тільки якщо він устигне завершитись — за оцінкою по
    // попередньому.
    if (nextStart - startedAt + lastDuration > budgetMs) break;

    const wait = nextStart - now();
    if (wait > 0) await sleep(wait);
  }

  return results;
}
