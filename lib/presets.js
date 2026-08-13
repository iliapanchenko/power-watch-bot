import { env } from './env.js';

/**
 * Готові набори налаштувань замість вільного вводу чисел.
 *
 * Причина не в зручності, а в захисті: крок опитування визначає, скільки
 * конектів на хвилину бот робить із інфраструктури Vercel. Вільне поле —
 * це запрошення вписати «5 секунд» і впертись у ліміти тарифу.
 */

/**
 * Чутливість до коротких провалів. Своя для кожного чату.
 * Поріг повернення скрізь однаковий: притримувати хороші новини сенсу немає.
 */
export const MODES = {
  швидкий: {
    failThreshold: 2,
    okThreshold: 2,
    about: 'знати одразу, ціною випадкових хибних тривог',
  },
  звичайний: {
    failThreshold: 4,
    okThreshold: 2,
    about: 'розумний баланс, рекомендований',
  },
  спокійний: {
    failThreshold: 8,
    okThreshold: 2,
    about: 'де зв\'язок нестабільний і блимання дратує',
  },
};

/**
 * Крок опитування, спільний для всіх чатів.
 * Усі значення ділять 60 націло — інакше на стику хвилин утворюється
 * розрив, довший за сам крок, і обіцяна реакція виявляється брехнею.
 */
export const TEMPOS = {
  частий: { seconds: 10, about: 'найшвидше, найбільше навантаження' },
  звичайний: { seconds: 15, about: 'типовий' },
  економний: { seconds: 30, about: 'найощадніше' },
};

// Змінні оточення можуть посунути типовий пресет, але не вигадати новий:
// невідома назва тихо відкочується до «звичайного».
export const DEFAULT_MODE = MODES[env.defaultMode] ? env.defaultMode : 'звичайний';
export const DEFAULT_TEMPO = TEMPOS[env.defaultTempo] ? env.defaultTempo : 'звичайний';

/** Назва пресета або його номер у списку. Регістр і пробіли не важливі. */
function lookup(table, value, fallback) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;

  const names = Object.keys(table);
  if (names.includes(raw)) return raw;

  const index = Number(raw);
  if (Number.isInteger(index) && index >= 1 && index <= names.length) {
    return names[index - 1];
  }
  return null;
}

/** @returns {string|null} назва пресета, або null якщо такого немає */
export function resolveMode(value) {
  return lookup(MODES, value, DEFAULT_MODE);
}

export function resolveTempo(value) {
  return lookup(TEMPOS, value, DEFAULT_TEMPO);
}

/** Пороги для чату. Невідома чи відсутня назва — типовий пресет. */
export function modeThresholds(name) {
  return MODES[name] ?? MODES[DEFAULT_MODE];
}

/** Крок опитування в секундах. */
export function tempoSeconds(name) {
  return (TEMPOS[name] ?? TEMPOS[DEFAULT_TEMPO]).seconds;
}

/** Через скільки секунд тиші чат дізнається про відключення. */
export function reactionSeconds(modeName, tempoName) {
  return tempoSeconds(tempoName) * modeThresholds(modeName).failThreshold;
}
