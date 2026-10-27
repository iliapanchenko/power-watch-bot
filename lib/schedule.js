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

  // З 23:45 до півночі закріплене показує вже завтрашній день.
  const { hour, minute } = kyivNow(new Date(now));
  const phase = hour * 60 + minute >= EVENING_POST_MINUTES ? 'evening' : 'day';

  return { today, tomorrow, days, phase };
}

/** Коли надсилати графік на завтра: 23:45 за Києвом. */
export const EVENING_POST_MINUTES = 23 * 60 + 45;

/** Чи дані дзеркала не оновлювались підозріло довго. */
export function staleHours(cache, now = Date.now()) {
  const updated = Date.parse(cache?.lastUpdated ?? '');
  if (!Number.isFinite(updated)) return null;
  const hours = (now - updated) / 3600000;
  return hours >= 6 ? Math.floor(hours) : 0;
}

/** Відключення дня, які ще не скінчились до моменту fromMinute. */
function remainingIntervals(code, fromMinute) {
  return dayIntervals(code).filter((interval) => interval.to > fromMinute);
}

/**
 * Один день графіка. fromMinute — для сьогоднішнього дня: відключення, що
 * вже минули, не показуються. Увечері графік на «сьогодні» з годинами,
 * які давно пройшли, нікому не потрібен.
 */
function renderDay(label, code, fromMinute = 0) {
  const lines = [`<b>${label}</b>`];

  if (code === '-') {
    lines.push('Графік ще не опублікований');
    return lines.join('\n');
  }

  const all = dayIntervals(code);
  const intervals = remainingIntervals(code, fromMinute);
  const definite = intervals.filter((interval) => interval.kind === 'off');
  const possible = intervals.filter((interval) => interval.kind === 'maybe');

  if (all.length === 0) {
    lines.push('⚡ Відключень не заплановано');
    return lines.join('\n');
  }
  if (intervals.length === 0) {
    lines.push('⚡ Більше відключень сьогодні не заплановано');
    return lines.join('\n');
  }

  for (const { from, to } of definite) lines.push(`⚫ ${formatMinutes(from)}–${formatMinutes(to)}`);
  for (const { from, to } of possible) lines.push(`◌ ${formatMinutes(from)}–${formatMinutes(to)} можливо`);

  // «Ще» — коли частина відключень уже позаду, щоб сума не читалась як
  // підсумок за весь день.
  // Відключення, що вже триває, рахуємо від поточної хвилини: о 20:00 від
  // проміжку 18:30–21:30 лишилось півтори години, а не три.
  const partial = intervals.length < all.length || intervals.some(({ from }) => from < fromMinute);
  const minutes = (list) =>
    list.reduce((sum, { from, to }) => sum + (to - Math.max(from, fromMinute)), 0);
  if (definite.length) {
    lines.push(`${partial ? 'Ще без світла' : 'Без світла'} ${humanDuration(minutes(definite) * 60)}`);
  }
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
export function renderSchedule({ group, address, snapshot, cache, emergency = false, now = Date.now() }) {
  const evening = snapshot.phase === 'evening';

  // Заголовок завжди починається з «Графік відключень»: за цими словами
  // вебхук упізнає службовий рядок про закріплення й прибирає його.
  const title = evening ? 'Графік відключень на завтра' : 'Графік відключень';
  const parts = [`<b>${title}, група ${escapeHtml(group)}</b>`];
  if (address) parts[0] += `\n${escapeHtml(address)}`;

  // Одразу під заголовком: у такий день години нижче мало що гарантують,
  // і людина має це побачити раніше за самі години.
  if (emergency) {
    parts.push('🚨 Зараз діють екстрені відключення, графік може не виконуватись');
  }

  const tomorrow = snapshot.days[snapshot.tomorrow];
  if (evening) {
    // З 23:45 сьогоднішній день уже прожитий, лишається лише завтрашній.
    // Тут «ще не опублікований» доречний: о такій порі його вже чекають.
    parts.push(renderDay(`Завтра, ${humanDate(snapshot.tomorrow)}`, tomorrow));
  } else {
    const todayCode = snapshot.days[snapshot.today];
    const { hour, minute } = kyivNow(new Date(now));
    const nowMinute = hour * 60 + minute;

    // Сьогодні — лише те, що ще попереду. Якщо попереду нічого, а графік
    // на завтра вже є, сьогоднішній день не показуємо зовсім: увечері,
    // коли ДТЕК публікує завтрашній графік, саме він і цікавий.
    const todayDone =
      todayCode !== '-' && remainingIntervals(todayCode, nowMinute).length === 0;
    if (!(todayDone && tomorrow !== '-')) {
      parts.push(renderDay(`Сьогодні, ${humanDate(snapshot.today)}`, todayCode, nowMinute));
    }

    // Завтрашній день — лише коли графік на нього вже є. ДТЕК публікує його
    // ввечері, і рядок «ще не опублікований» з самого ранку лише заважав.
    if (tomorrow !== '-') parts.push(renderDay(`Завтра, ${humanDate(snapshot.tomorrow)}`, tomorrow));
  }

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
 *   'new'  — новий допис зі звуком;
 *   'edit' — тихо переписати наявний;
 *   'none' — нічого не змінилось.
 *
 * Новий допис — коли з'явився або змінився графік, і ще щовечора о 23:45:
 * графік на завтра, поки люди ще не сплять. Опівночі той самий допис лише
 * тихо переписується з «Завтра» на «Сьогодні» — будити о 00:00 нема за що.
 */
export function classifyChange(previous, next) {
  if (!previous?.messageId) return 'new';
  if (previous.group !== next.group) return 'new';

  for (const [date, code] of Object.entries(next.days)) {
    const before = previous.days?.[date];
    // День, якого ми ще не показували. Північ сама по собі не новина,
    // а от уже опублікований графік на нього — новина.
    if (before === undefined) {
      if (code !== '-') return 'new';
      continue;
    }
    if (before !== code) return 'new';
  }

  if (next.phase === 'evening' && previous.phase !== 'evening') return 'new';
  return previous.text === next.text ? 'none' : 'edit';
}

export const EMERGENCY = 'EmergencyShutdowns';

/**
 * Що сталось із режимом екстрених відключень між двома перевірками:
 *   'active'  — уперше бачимо цей чат, а екстрені вже тривають;
 *   'started' — почались;
 *   'ended'   — скінчились;
 *   null      — нічого нового.
 *
 * Кінцем вважається будь-який інший статус, а не якесь одне очікуване
 * слово: як Yasno позначає звичайний режим, ми ще не бачили, і бот не має
 * пропустити скасування лише через те, що слово виявилось іншим.
 */
export function emergencyEvent(previous, current) {
  // Немає даних (Yasno не відповів, групи нема) — нічого не вирішуємо,
  // інакше збій мережі виглядав би як скасування екстрених відключень.
  if (current == null) return null;

  const isNow = current === EMERGENCY;
  if (previous == null) return isNow ? 'active' : null;

  const wasBefore = previous === EMERGENCY;
  if (!wasBefore && isNow) return 'started';
  if (wasBefore && !isNow) return 'ended';
  return null;
}

export function renderEmergency(event, placeIn) {
  if (event === 'started') {
    return `🚨 У ${placeIn} почались екстрені відключення\nГрафіки зараз не діють, світло можуть вимкнути будь-коли`;
  }
  if (event === 'active') {
    return `🚨 У ${placeIn} зараз діють екстрені відключення\nГрафіки не діють, світло можуть вимкнути будь-коли`;
  }
  if (event === 'ended') {
    return '✅ Екстрені відключення скасовано\nВідключення відбуваються за графіком';
  }
  return null;
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
