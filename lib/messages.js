import { escapeHtml } from './telegram.js';
import { humanDuration, humanDurationOrZero, kyivDate, kyivTime } from './format.js';

/**
 * Тексти всіх сповіщень. Тут немає ні мережі, ні сховища — лише
 * перетворення чисел на слова, тому вигляд можна подивитись, не
 * піднімаючи бота: node scripts/preview-messages.mjs
 */

export function renderTransition({ device, to, at, durationSec }) {
  const lines = [`<b>${escapeHtml(device.name)}</b>`];

  if (to === 'down') {
    lines.push(`❌ Електропостачання зникло о ${kyivTime(at)}`);
    // Тривалості немає лише при першому в житті відключенні: попереднього
    // стану ще не було, рахувати нема від чого.
    if (durationSec != null) lines.push(`⏳ Світло було ${humanDuration(durationSec)}`);
  } else {
    lines.push(`⚡ Електропостачання повернулося о ${kyivTime(at)}`);
    if (durationSec != null) lines.push(`⏳ Світла не було ${humanDuration(durationSec)}`);
  }

  return lines.join('\n');
}

/** Один блок «скільки було / скільки не було» — спільний для звіту і /today. */
function renderBalance(name, upSec, downSec, scheduledSec) {
  const lines = [
    `<b>${escapeHtml(name)}</b>`,
    downSec < 60
      ? '⚡ Світло було протягом усього дня'
      : `⚡ Світло було ${humanDurationOrZero(upSec)}`,
    `❌ Світла не було ${humanDurationOrZero(downSec)}`,
  ];

  // Лише для чатів з адресою: без графіка порівнювати нема з чим.
  const split = renderScheduleSplit(downSec, scheduledSec);
  if (split) lines.push(split);
  return lines.join('\n');
}

/**
 * Скільки з відключень обіцяв графік, а скільки — ні.
 * Саме цього не показують ні ДТЕК, ні «Київ Цифровий»: вони бачать
 * графік, але не бачать справжнього світла.
 */
export function renderScheduleSplit(downSec, scheduledSec) {
  if (scheduledSec == null || downSec < 60) return null;
  const unscheduled = downSec - scheduledSec;

  if (unscheduled < 60) return '↳ усе за графіком';
  if (scheduledSec < 60) return '↳ усе поза графіком';
  return `↳ за графіком ${humanDuration(scheduledSec)}, поза графіком ${humanDuration(unscheduled)}`;
}

export function renderDailyReport(entries, at) {
  const blocks = entries.map(({ name, upSec, downSec, scheduledSec }) =>
    renderBalance(name, upSec, downSec, scheduledSec)
  );
  return `<b>Звіт за ${kyivDate(at)}</b>\n\n${blocks.join('\n\n')}`;
}

export function renderTodayReport(entries, at) {
  const blocks = entries.map(({ name, upSec, downSec }) =>
    renderBalance(name, upSec, downSec)
  );
  return `<b>Сьогодні, станом на ${kyivTime(at)}</b>\n\n${blocks.join('\n\n')}`;
}
