import { fileURLToPath } from 'node:url';
import { dayIntervals } from './schedule.js';

/**
 * Графік відключень картинкою: по смузі з 24 годин на день, червоне —
 * світла нема, зелене — є, помаранчеве — можливо. Півгодини — половинка
 * клітинки.
 *
 * Тут лише смуги й підписи годин. Відлік «увімкнуть через…» живе в
 * тексті над картинкою: той переписується щохвилини, а картинка — раз на
 * пів години, і відлік на ній брехав би.
 *
 * renderScheduleSvg — чиста функція, перевіряється тестами без шрифтів і
 * рендерера. renderSchedulePng малює її у PNG для Telegram.
 */

const C = {
  bg: '#1c1c1e',
  off: '#e5533d',
  on: '#34c759',
  maybe: '#ff9f0a',
  none: '#3a3a3c',
  text: '#f2f2f7',
  dim: '#8e8e93',
  now: '#ffffff',
};

const W = 1080;
const PAD = 48;
const LABEL_W = 120;
const GRID_X = PAD + LABEL_W;
const CELL_GAP = 6;
const CELL_W = (W - GRID_X - PAD - CELL_GAP * 23) / 24;
const ROW_H = 76;
const ROW_GAP = 18;

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const color = (kind) => (kind === 'off' ? C.off : kind === 'maybe' ? C.maybe : C.on);

/** Стан кожної з 48 половин доби: null | 'off' | 'maybe'. */
function halves(code) {
  const cells = Array(48).fill(null);
  for (const { from, to, kind } of dayIntervals(code)) {
    for (let minute = from; minute < to; minute += 30) cells[minute / 30] = kind;
  }
  return cells;
}

function renderRow(y, { label, code, nowMinute = null }) {
  const out = [
    `<text x="${PAD}" y="${y + ROW_H / 2 + 14}" font-size="40" font-weight="700" fill="${C.text}">${escape(label)}</text>`,
  ];
  const cells = code === '-' ? null : halves(code);

  for (let hour = 0; hour < 24; hour += 1) {
    const x = GRID_X + hour * (CELL_W + CELL_GAP);
    const [first, second] = cells ? [cells[hour * 2], cells[hour * 2 + 1]] : [];
    if (!cells) {
      out.push(`<rect x="${x}" y="${y}" width="${CELL_W}" height="${ROW_H}" rx="8" fill="${C.none}"/>`);
    } else if (first === second) {
      out.push(`<rect x="${x}" y="${y}" width="${CELL_W}" height="${ROW_H}" rx="8" fill="${color(first)}"/>`);
    } else {
      const half = (CELL_W - 4) / 2;
      out.push(`<rect x="${x}" y="${y}" width="${half}" height="${ROW_H}" rx="6" fill="${color(first)}"/>`);
      out.push(`<rect x="${x + half + 4}" y="${y}" width="${half}" height="${ROW_H}" rx="6" fill="${color(second)}"/>`);
    }
  }

  if (!cells) {
    out.push(
      `<text x="${GRID_X + (W - GRID_X - PAD) / 2}" y="${y + ROW_H / 2 + 10}" font-size="30" text-anchor="middle" fill="${C.dim}">графік ще не опублікований</text>`
    );
  }

  if (nowMinute != null) {
    const hour = Math.floor(nowMinute / 60);
    const x = GRID_X + hour * (CELL_W + CELL_GAP) + ((nowMinute % 60) / 60) * CELL_W;
    out.push(`<rect x="${x - 2.5}" y="${y - 8}" width="5" height="${ROW_H + 16}" rx="2.5" fill="${C.now}"/>`);
  }
  return out.join('');
}

const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** '2026-11-09' → 'Пн'. Опівдні UTC, щоб жоден часовий пояс не зсунув день. */
export function weekday(date) {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

/**
 * Смуги для закріпленого. Удень — сьогодні з рискою «зараз» і завтра
 * (сіре, поки не опубліковане); з 23:45 — лише завтра, як і в тексті.
 */
export function pinnedImageRows(snapshot, nowMinute) {
  const tomorrow = { label: weekday(snapshot.tomorrow), code: snapshot.days[snapshot.tomorrow] };
  if (snapshot.phase === 'evening') return [tomorrow];
  return [{ label: weekday(snapshot.today), code: snapshot.days[snapshot.today], nowMinute }, tomorrow];
}

/**
 * Коли картинку пора перемалювати: змінились години чи настало нове
 * пів години (риска «зараз» мусить посунутись). Сама хвилина в ключ не
 * входить — інакше картинка мінялась би щохвилини.
 */
export function imageKey(rows) {
  return rows
    .map(({ label, code, nowMinute }) =>
      nowMinute == null ? `${label}:${code}` : `${label}:${code}@${Math.floor(nowMinute / 30)}`
    )
    .join('|');
}

/**
 * rows — [{ label: 'Пн', code: 'nnfyy…' | '-', nowMinute? }].
 * Рядок із nowMinute отримує білу риску «зараз», а його година у шкалі
 * виділяється.
 */
export function renderScheduleSvg(rows) {
  const parts = [];
  const nowMinute = rows.find((row) => row.nowMinute != null)?.nowMinute;
  let y = PAD + 22;

  // Кожна година: більший шрифт уже злипається на ширині клітинки.
  for (let hour = 0; hour < 24; hour += 1) {
    const x = GRID_X + hour * (CELL_W + CELL_GAP) + CELL_W / 2;
    const isNow = nowMinute != null && Math.floor(nowMinute / 60) === hour;
    parts.push(
      `<text x="${x}" y="${y}" font-size="${isNow ? 26 : 22}" font-weight="${isNow ? 700 : 400}" text-anchor="middle" fill="${isNow ? C.text : C.dim}">${String(hour).padStart(2, '0')}</text>`
    );
  }
  y += 22;

  for (const row of rows) {
    parts.push(renderRow(y, row));
    y += ROW_H + ROW_GAP;
  }

  // Легенда праворуч унизу.
  y += 28;
  let x = W - PAD;
  for (const [fill, label] of [[C.maybe, 'можливо'], [C.on, 'є'], [C.off, 'немає']]) {
    x -= label.length * 16 + 36;
    parts.push(`<rect x="${x}" y="${y - 23}" width="24" height="24" rx="5" fill="${fill}"/>`);
    parts.push(`<text x="${x + 32}" y="${y - 1}" font-size="28" fill="${C.dim}">${label}</text>`);
    x -= 18;
  }
  y += PAD - 18;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="Inter">` +
    `<rect width="100%" height="100%" fill="${C.bg}"/>${parts.join('')}</svg>`
  );
}

// Шрифт іде разом із кодом: на Vercel системних шрифтів немає, і без
// нього всі підписи просто зникли б. У збірку функції його додає
// includeFiles у vercel.json.
const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map((name) =>
  fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url))
);

export async function renderSchedulePng(rows) {
  // Рендерер — нативний модуль на кілька мегабайтів. Вантажимо лише тоді,
  // коли справді малюємо, щоб вебхук і решта функцій його не тягли.
  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(renderScheduleSvg(rows), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' },
  });
  return resvg.render().asPng();
}
