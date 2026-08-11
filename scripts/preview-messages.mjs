/**
 * Показати, як виглядатимуть повідомлення в чаті.
 *
 *   node scripts/preview-messages.mjs
 *
 * Нічого нікуди не надсилає — просто рендерить тексти на вигаданих даних.
 */
import {
  renderTransition,
  renderDailyReport,
  renderTodayReport,
} from '../lib/messages.js';

const HOUR = 3600;
const MIN = 60;

// Фіксований момент, щоб превʼю не мінялось від запуску до запуску.
const at = new Date('2026-08-11T12:59:00Z').getTime(); // 15:59 за Києвом
const back = new Date('2026-08-11T13:45:00Z').getTime(); // 16:45 за Києвом
const midnight = new Date('2026-08-11T20:59:00Z').getTime(); // 23:59 за Києвом

function show(title, html) {
  const text = html
    .replace(/<\/?b>/g, '')
    .replace(/<\/?code>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  console.log(`\n\x1b[2m── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}\x1b[0m`);
  for (const line of text.split('\n')) console.log('  ' + line);
}

show(
  'світло зникло',
  renderTransition({
    device: { name: 'Квартира' },
    to: 'down',
    at,
    durationSec: 53 * 24 * HOUR + 9 * HOUR + 55 * MIN,
  })
);

show(
  'світло повернулось',
  renderTransition({
    device: { name: 'Квартира' },
    to: 'up',
    at: back,
    durationSec: 46 * MIN,
  })
);

show(
  'перше відключення, попереднього стану ще не було',
  renderTransition({ device: { name: 'Дача' }, to: 'down', at, durationSec: null })
);

show(
  'коротке відключення',
  renderTransition({
    device: { name: 'Квартира' },
    to: 'up',
    at: back,
    durationSec: 40,
  })
);

show(
  'звіт за день без відключень',
  renderDailyReport([{ name: 'Квартира', upSec: 24 * HOUR, downSec: 0 }], midnight)
);

show(
  'звіт за день із відключеннями',
  renderDailyReport(
    [{ name: 'Квартира', upSec: 21 * HOUR + 35 * MIN, downSec: 2 * HOUR + 25 * MIN }],
    midnight
  )
);

show(
  'звіт на дві адреси',
  renderDailyReport(
    [
      { name: 'Квартира', upSec: 21 * HOUR + 35 * MIN, downSec: 2 * HOUR + 25 * MIN },
      { name: 'Дача', upSec: 24 * HOUR, downSec: 0 },
    ],
    midnight
  )
);

show(
  'команда /today посеред дня',
  renderTodayReport(
    [{ name: 'Квартира', upSec: 12 * HOUR + 4 * MIN, downSec: 1 * HOUR + 1 * MIN }],
    back
  )
);

console.log('');
