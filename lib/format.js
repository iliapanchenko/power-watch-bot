const KYIV = 'Europe/Kyiv';

/** Українське відмінювання: 1 хвилина, 2 хвилини, 5 хвилин. */
function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * 4611600 -> "53 дні 9 годин 55 хвилин".
 *
 * Форми знахідного відмінка, бо фраза завжди така: «світло було ...»,
 * «світла не було ...». У називному вийшло б «світло було 1 година».
 */
export function humanDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'невідомо скільки';

  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return 'менше хвилини';

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days} ${plural(days, 'день', 'дні', 'днів')}`);
  if (hours) parts.push(`${hours} ${plural(hours, 'годину', 'години', 'годин')}`);
  if (minutes) parts.push(`${minutes} ${plural(minutes, 'хвилину', 'хвилини', 'хвилин')}`);

  return parts.join(' ');
}

/** Те саме, але нуль показується як «0 хвилин» — для рядків звіту. */
export function humanDurationOrZero(seconds) {
  const total = Math.max(0, Math.round(seconds ?? 0));
  return total < 60 ? '0 хвилин' : humanDuration(total);
}

/** "15:59" за Києвом. */
export function kyivTime(at = Date.now()) {
  const { hour, minute } = kyivNow(new Date(at));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "11.08.2026" за Києвом. */
export function kyivDate(at = Date.now()) {
  const [year, month, day] = kyivNow(new Date(at)).date.split('-');
  return `${day}.${month}.${year}`;
}

export function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('uk-UA', {
    timeZone: KYIV,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function secondsSince(value) {
  if (!value) return null;
  return Math.round((Date.now() - new Date(value).getTime()) / 1000);
}

/**
 * Київські дата й час незалежно від того, в якому регіоні крутиться функція.
 * Vercel живе в UTC, а підсумок дня має приходити о 23:59 за Києвом
 * і влітку, і взимку — тому рахуємо через часовий пояс, а не через зсув.
 *
 * @returns {{date: string, hour: number, minute: number}} date у форматі YYYY-MM-DD
 */
export function kyivNow(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

export const statusIcon = { up: '🟢', down: '🔴', unknown: '⚪️' };

export const statusWord = {
  up: 'світло є',
  down: 'світла нема',
  unknown: 'ще не перевірялось',
};
