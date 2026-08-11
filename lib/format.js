const KYIV = 'Europe/Kyiv';

/** Українське відмінювання: 1 хвилина, 2 хвилини, 5 хвилин. */
function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** 8500 -> "2 год 21 хв". Найбільші дві одиниці, без секундного шуму. */
export function humanDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return 'невідомо скільки';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} ${plural(total, 'секунду', 'секунди', 'секунд')}`;

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days} ${plural(days, 'день', 'дні', 'днів')}`);
  if (hours) parts.push(`${hours} год`);
  if (minutes && !days) parts.push(`${minutes} хв`);
  return parts.join(' ') || 'менше хвилини';
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
