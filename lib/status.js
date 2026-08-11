/**
 * Чиста логіка стану однієї адреси: без мережі, без Redis, без Telegram.
 * Усе рішення «чи це вже подія» приймається тут, тому його можна ганяти
 * тестами на вигаданому годиннику.
 */

export function emptyState() {
  return {
    status: 'unknown',
    statusSince: null, // коли встановився поточний статус
    downSince: null, // від якого моменту рахуємо відключення в добовий підсумок
    downToday: 0, // накопичені секунди без світла за поточну добу
    dayStart: null, // від якого моменту ведемо облік поточної доби
    fail: 0,
    ok: 0,
  };
}

/**
 * Застосувати результат однієї проби.
 *
 * Статус міняється не з першої тиші, а за гістерезисом: інакше один
 * загублений пакет о третій ночі будив би людину двома повідомленнями
 * поспіль.
 *
 * @returns {{state: object, transition: object|null}}
 *   transition === null, якщо писати в чат нема про що
 */
export function applyProbe(previous, alive, now, { failThreshold, okThreshold }) {
  const prev = previous ?? emptyState();

  // Лічильники впираються в поріг, щоб не рости нескінченно за тижні аптайму.
  const fail = alive ? 0 : Math.min(prev.fail + 1, failThreshold);
  const ok = alive ? Math.min(prev.ok + 1, okThreshold) : 0;

  let status = prev.status;
  if (alive && ok >= okThreshold) status = 'up';
  if (!alive && fail >= failThreshold) status = 'down';

  const state = { ...prev, fail, ok, status };

  // Точку щойно взяли під нагляд — звідси й рахуємо її першу добу.
  if (state.dayStart == null) state.dayStart = now;

  if (status === prev.status) return { state, transition: null };

  const durationSec =
    prev.statusSince == null ? null : Math.round((now - prev.statusSince) / 1000);

  state.statusSince = now;

  if (status === 'down') {
    state.downSince = now;
  } else if (prev.downSince != null) {
    state.downToday += Math.round((now - prev.downSince) / 1000);
    state.downSince = null;
  }

  // Перший в житті вдалий контакт — не подія, адреса просто вийшла на зв'язок.
  const isFirstContact = prev.status === 'unknown' && status === 'up';

  return {
    state,
    transition: isFirstContact ? null : { to: status, durationSec },
  };
}

/**
 * Підбити добу і почати нову.
 *
 * Якщо світла нема просто зараз, поточне відключення ріжеться по межі доби:
 * прожита частина йде в сьогоднішній підсумок, решта рахуватиметься вже
 * як завтрашня. Інакше довге нічне відключення не потрапило б у жоден звіт.
 *
 * Час зі світлом не накопичується окремо, а рахується як залишок від
 * прожитого під наглядом. Так воно завжди сходиться в суму, і перша
 * неповна доба (точку додали ополудні) не перетворюється на 12 годин
 * вигаданої темряви.
 *
 * @returns {{state: object, downSec: number, upSec: number, trackedSec: number}}
 */
export function closeDay(previous, now) {
  const state = { ...(previous ?? emptyState()) };
  let downSec = state.downToday;

  if (state.status === 'down' && state.downSince != null) {
    downSec += Math.round((now - state.downSince) / 1000);
    state.downSince = now;
  }

  const trackedSec =
    state.dayStart == null ? 0 : Math.max(0, Math.round((now - state.dayStart) / 1000));
  const upSec = Math.max(0, trackedSec - downSec);

  state.downToday = 0;
  state.dayStart = now;
  return { state, downSec, upSec, trackedSec };
}
