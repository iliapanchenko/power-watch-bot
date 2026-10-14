import { escapeHtml } from './telegram.js';
import { humanDuration, kyivNow } from './format.js';

/**
 * Чиста логіка графіків відключень: жодної мережі, жодного сховища.
 *
 * Графік ДТЕК — це 24 клітинки на добу для кожної групи, кожна з яких
 * каже, що буде протягом години: світло є, немає, немає першу чи другу
 * половину, і те саме з приміткою «можливо». Тут ці клітинки
 * перетворюються на проміжки «з — до», які людина читає з першого погляду.
 */

// Однією літерою на годину: доба групи вміщується в рядок із 24 символів,
// і в Redis лягають усі 60 груп разом на кілька кілобайт.
const ENCODE = {
  yes: 'y',
  no: 'n',
  first: 'f',
  second: 's',
  maybe: 'm',
  mfirst: 'F',
  msecond: 'S',
};

/**
 * Що відбувається в кожній половині години: null — світло є,
 * 'off' — точно немає, 'maybe' — можливо немає.
 * Невідоме значення трактуємо як «можливо»: краще попередити зайвий раз,
 * ніж пообіцяти світло, про яке ми нічого не знаємо.
 */
const HALVES = {
  y: [null, null],
  n: ['off', 'off'],
  f: ['off', null],
  s: [null, 'off'],
  m: ['maybe', 'maybe'],
  F: ['maybe', null],
  S: [null, 'maybe'],
};

export function encodeDay(hours) {
  let out = '';
  for (let hour = 1; hour <= 24; hour += 1) {
    out += ENCODE[hours?.[String(hour)]] ?? '?';
  }
  return out;
}

/**
 * «f················nnnf···» → [{from: 0, to: 30, kind: 'off'}, {from: 1020, to: 1230, ...}]
 * Хвилини від початку доби за Києвом. Сусідні однакові половини злипаються,
 * тож 17:00–18:00, 18:00–19:00 і 19:00–20:00 стають одним 17:00–20:00.
 */
export function dayIntervals(code) {
  const cells = [];
  for (const letter of code ?? '') cells.push(...(HALVES[letter] ?? ['maybe', 'maybe']));

  const intervals = [];
  for (let index = 0; index < cells.length; index += 1) {
    const kind = cells[index];
    if (!kind) continue;
    const last = intervals.at(-1);
    if (last && last.kind === kind && last.to === index * 30) {
      last.to = (index + 1) * 30;
    } else {
      intervals.push({ from: index * 30, to: (index + 1) * 30, kind });
    }
  }
  return intervals;
}

/** 1020 → «17:00», 1440 → «24:00». */
export function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Зсув Києва від UTC у хвилинах на конкретний момент: 120 узимку, 180 улітку. */
export function kyivOffsetMinutes(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * Київський час «стільки-то хвилин після півночі» → мітка часу.
 *
 * Просто додати хвилини до півночі не можна: двічі на рік доба триває 23
 * чи 25 годин, і всі проміжки після переведення годинника з'їхали б на
 * годину. Тому поправляємо на різницю зсувів між північчю і цим моментом.
 */
export function kyivLocalToMs(dayStartMs, minutes) {
  const naive = dayStartMs + minutes * 60000;
  const shift = kyivOffsetMinutes(naive) - kyivOffsetMinutes(dayStartMs);
  return naive - shift * 60000;
}

/**
 * Усі проміжки групи на всіх відомих днях — уже в абсолютному часі.
 * Так відключення, що перетинає північ, рахується правильно без окремих
 * хитрощів для межі доби.
 */
export function absoluteIntervals(days, group, kind = 'off') {
  const out = [];
  for (const day of days ?? []) {
    const code = day.groups?.[group];
    if (!code) continue;
    for (const interval of dayIntervals(code)) {
      if (interval.kind !== kind) continue;
      out.push({
        start: kyivLocalToMs(day.start, interval.from),
        end: kyivLocalToMs(day.start, interval.to),
      });
    }
  }
  return out;
}

/** Скільки секунд проміжку [from, to] припало на заплановані відключення. */
export function overlapSeconds(fromMs, toMs, intervals) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  for (const { start, end } of intervals ?? []) {
    const overlap = Math.min(toMs, end) - Math.max(fromMs, start);
    if (overlap > 0) total += overlap;
  }
  return Math.round(total / 1000);
}

const MONTHS = [
  'січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня',
];

function humanDate(dateKey) {
  const [, month, day] = dateKey.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/**
 * Які дні показувати в закріпленому: сьогодні й завтра за Києвом.
 * '-' означає, що графік на цей день ще не опублікований.
 */
export function scheduleSnapshot(cache, group, now = Date.now()) {
  const today = kyivNow(new Date(now)).date;
  const tomorrow = kyivNow(new Date(now + 26 * 3600 * 1000)).date === today
    ? kyivNow(new Date(now + 30 * 3600 * 1000)).date
    : kyivNow(new Date(now + 24 * 3600 * 1000)).date;

  const byDate = new Map((cache?.days ?? []).map((day) => [day.date, day]));
  const days = {};
  for (const date of [today, tomorrow]) {
    days[date] = byDate.get(date)?.groups?.[group] ?? '-';
  }
  return { today, tomorrow, days };
}

/** Чи дані дзеркала не оновлювались підозріло довго. */
export function staleHours(cache, now = Date.now()) {
  const updated = Date.parse(cache?.lastUpdated ?? '');
  if (!Number.isFinite(updated)) return null;
  const hours = (now - updated) / 3600000;
  return hours >= 6 ? Math.floor(hours) : 0;
}

function renderDay(label, code) {
  const lines = [`<b>${label}</b>`];

  if (code === '-') {
    lines.push('Графік ще не опублікований');
    return lines.join('\n');
  }

  const intervals = dayIntervals(code);
  const definite = intervals.filter((interval) => interval.kind === 'off');
  const possible = intervals.filter((interval) => interval.kind === 'maybe');

  if (intervals.length === 0) {
    lines.push('⚡ Відключень не заплановано');
    return lines.join('\n');
  }

  for (const { from, to } of definite) lines.push(`⚫ ${formatMinutes(from)}–${formatMinutes(to)}`);
  for (const { from, to } of possible) lines.push(`◌ ${formatMinutes(from)}–${formatMinutes(to)} можливо`);

  const minutes = (list) => list.reduce((sum, { from, to }) => sum + (to - from), 0);
  if (definite.length) lines.push(`Без світла ${humanDuration(minutes(definite) * 60)}`);
  if (possible.length) lines.push(`Можливо ще ${humanDuration(minutes(possible) * 60)}`);

  return lines.join('\n');
}

/**
 * Текст закріпленого повідомлення.
 *
 * Дати пишуться словами, а «сьогодні/завтра» — лише підписом: так видно,
 * що опівночі змінився саме день, а не години відключень, і новий допис
 * може прийти без звуку (див. classifyChange).
 */
export function renderSchedule({ group, address, snapshot, cache, now = Date.now() }) {
  const parts = [`<b>Графік відключень, група ${escapeHtml(group)}</b>`];
  if (address) parts[0] += `\n${escapeHtml(address)}`;

  parts.push(renderDay(`Сьогодні, ${humanDate(snapshot.today)}`, snapshot.days[snapshot.today]));
  parts.push(renderDay(`Завтра, ${humanDate(snapshot.tomorrow)}`, snapshot.days[snapshot.tomorrow]));

  const footer = [];
  if (cache?.dtekUpdate) footer.push(`<i>Дані ДТЕК на ${escapeHtml(cache.dtekUpdate)}</i>`);
  const stale = staleHours(cache, now);
  if (stale) {
    footer.push(`⚠️ Джерело не оновлювалось ${humanDuration(stale * 3600)}, графік може бути застарілим`);
  }
  if (footer.length) parts.push(footer.join('\n'));

  return parts.join('\n\n');
}

/**
 * Що робити з закріпленим повідомленням:
 *   'new'   — новий допис зі звуком: з'явився або змінився графік;
 *   'quiet' — новий допис без звуку: настала північ, а годин ніхто не міняв;
 *   'edit'  — переписати наявний: змінилась лише примітка під графіком;
 *   'none'  — нічого не змінилось.
 *
 * Звук — лише тоді, коли змінились самі години відключень. Опівночі графік
 * на новий день приходить свіжим дописом, щоб уранці лежати внизу чату,
 * але беззвучно: будити людей о 00:00 заради зміни підпису «сьогодні» нема за що.
 */
export function classifyChange(previous, next) {
  if (!previous?.messageId) return 'new';
  if (previous.group !== next.group) return 'new';

  let rolledOver = false;
  for (const [date, code] of Object.entries(next.days)) {
    const before = previous.days?.[date];
    if (before === undefined) {
      // День, якого ми ще не показували. Північ сама по собі не новина,
      // а от уже опублікований графік на нього — новина.
      if (code !== '-') return 'new';
      rolledOver = true;
      continue;
    }
    if (before !== code) return 'new';
  }

  if (rolledOver) return 'quiet';
  return previous.text === next.text ? 'none' : 'edit';
}

/**
 * Початки відключень, про які пора попередити: від зараз до leadMs уперед,
 * і про які ще не попереджали.
 */
export function dueWarnings(intervals, warned, now, leadMs = 30 * 60000) {
  const seen = new Set(warned ?? []);
  return (intervals ?? []).filter(
    ({ start }) => start > now && start - now <= leadMs && !seen.has(String(start))
  );
}

/**
 * «вул. Олеся Олександра, 2А» → { street: 'вул. Олеся Олександра', house: '2А' }.
 * Останнє слово — будинок, решта — вулиця.
 */
export function parseAddress(text) {
  const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const house = tokens.pop().replace(/^[,.]+|[,.]+$/g, '');
  if (/^(буд\.?|будинок|б\.)$/i.test(tokens.at(-1) ?? '')) tokens.pop();

  const street = tokens.join(' ').replace(/[,]+$/, '').trim();
  if (!street || !house) return null;
  return { street, house };
}

// Латинські літери, які на клавіатурі легко сплутати з кириличними.
const LOOKALIKE = { A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х' };

/** «2a», «2-А», «2 а» → «2А», щоб порівнювати з тим, що віддає Yasno. */
export function normalizeHouse(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[ABCEHKMOPTX]/g, (letter) => LOOKALIKE[letter])
    .replace(/(\d)\s*[-–]?\s*(?=[А-ЯІЇЄҐ])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const STREET_PREFIX =
  /^(вул\.?|вулиця|просп\.?|проспект|пров\.?|провулок|бульв\.?|бульвар|пл\.?|площа|наб\.?|набережна|узвіз|сел\.?|шосе|тупик|проїзд)\s+/;

export function normalizeStreet(value, { stripPrefix = false } = {}) {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/[’'`ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return stripPrefix ? base.replace(STREET_PREFIX, '') : base;
}

/**
 * Обрати вулицю з результатів пошуку. Пошук Yasno поблажливий і часто
 * повертає кілька варіантів («Перемоги» — і вулиця, і селище), тому
 * спершу шукаємо точний збіг, і лише потім погоджуємось на єдиний результат.
 *
 * @returns {{match: object} | {ambiguous: object[]} | {none: true}}
 */
export function pickStreet(query, results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return { none: true };

  const full = list.filter((item) => normalizeStreet(item.value) === normalizeStreet(query));
  if (full.length === 1) return { match: full[0] };

  const bare = list.filter(
    (item) =>
      normalizeStreet(item.value, { stripPrefix: true }) ===
      normalizeStreet(query, { stripPrefix: true })
  );
  if (bare.length === 1) return { match: bare[0] };

  if (list.length === 1) return { match: list[0] };
  return { ambiguous: (bare.length ? bare : list).slice(0, 6) };
}
