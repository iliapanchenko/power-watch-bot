import { encodeDay, normalizeHouse, pickStreet } from './schedule.js';
import { kyivNow } from './format.js';

/**
 * Звідки беруться графіки.
 *
 * Два джерела, кожне на своє:
 *   - Yasno — щоб знайти групу за адресою. API відкритий і точний,
 *     але в дні екстрених відключень сам графік там порожній.
 *   - Дзеркало ДТЕК на GitHub — щоб брати сам графік. Сайт ДТЕК закритий
 *     від ботів, а це дзеркало публікує ті самі дані звичайним JSON.
 *     Це чужий проєкт, тому бот стежить за датою оновлення й прямо каже,
 *     коли дані застаріли.
 *
 * Поки лише Київ. Інші регіони додаються сюди окремим записом.
 */
export const REGIONS = {
  kyiv: {
    name: 'Київ',
    // Місцевий відмінок окремо: «у Києві» з назви не виводиться.
    nameIn: 'Києві',
    yasno: { regionId: 25, dsoId: 902 },
    mirror: 'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json',
  },
};

const YASNO = 'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2';

async function getJson(url, timeoutMs = 15000) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'power-watch-bot' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${url.split('?')[0]}`);
  return response.json();
}

/**
 * Свіжий графік у компактному вигляді для Redis:
 * { fetchedAt, lastUpdated, dtekUpdate, days: [{ date, start, groups: { '4.1': 'yyy…' } }] }
 *
 * Зберігаємо всі групи, а не лише потрібні: так новий чат отримує графік
 * одразу, не чекаючи наступного завантаження.
 */
export async function fetchRegionSchedule(regionKey, now = Date.now()) {
  const region = REGIONS[regionKey];
  if (!region) throw new Error(`Невідомий регіон: ${regionKey}`);

  const raw = await getJson(region.mirror, 20000);
  const yesterday = kyivNow(new Date(now - 24 * 3600 * 1000)).date;

  const days = [];
  for (const [timestamp, groups] of Object.entries(raw?.fact?.data ?? {})) {
    const start = Number(timestamp) * 1000;
    if (!Number.isFinite(start)) continue;
    const date = kyivNow(new Date(start)).date;
    // Вчорашній день ще потрібен для звіту о 23:59 і відключень через північ,
    // старіші — ні.
    if (date < yesterday) continue;

    const compact = {};
    for (const [key, hours] of Object.entries(groups ?? {})) {
      compact[key.replace(/^GPV/, '')] = encodeDay(hours);
    }
    days.push({ date, start, groups: compact });
  }
  days.sort((a, b) => a.start - b.start);

  return {
    region: regionKey,
    fetchedAt: now,
    lastUpdated: raw?.lastUpdated ?? null,
    dtekUpdate: raw?.fact?.update ?? null,
    days,
  };
}

/**
 * Адреса → група, ланцюжком «вулиця → будинок → група», як робить сам
 * сайт Yasno.
 *
 * @returns {Promise<
 *   | {ok: true, group: string, address: string}
 *   | {ok: false, error: string}
 * >}
 */
export async function resolveGroup(regionKey, street, house) {
  const region = REGIONS[regionKey];
  const { regionId, dsoId } = region.yasno;
  const query = (params) => new URLSearchParams({ regionId, dsoId, ...params }).toString();

  let streets = await getJson(`${YASNO}/streets?${query({ query: street })}`);
  if (!Array.isArray(streets) || streets.length === 0) {
    // Пошук Yasno не любить префіксів на кшталт «просп.», тож пробуємо без них.
    const bare = street.replace(/^\S+\.\s+/, '');
    if (bare !== street) streets = await getJson(`${YASNO}/streets?${query({ query: bare })}`);
  }

  const picked = pickStreet(street, streets);
  if (picked.none) {
    return { ok: false, error: `Не знайшов вулицю «${street}» у ${region.nameIn}. Перевір написання.` };
  }
  if (picked.ambiguous) {
    return {
      ok: false,
      error:
        'Під це підходить кілька вулиць, уточни:\n' +
        picked.ambiguous.map((item) => `• ${item.value}`).join('\n'),
    };
  }

  const houses = await getJson(
    `${YASNO}/houses?${query({ streetId: picked.match.id, query: house.replace(/\D.*$/, '') })}`
  );
  const wanted = normalizeHouse(house);
  const found = (Array.isArray(houses) ? houses : []).find(
    (item) => normalizeHouse(item.value) === wanted
  );
  if (!found) {
    const options = (Array.isArray(houses) ? houses : []).slice(0, 10).map((item) => item.value);
    return {
      ok: false,
      error:
        `На ${picked.match.value} немає будинку «${house}».` +
        (options.length ? `\nСхожі: ${options.join(', ')}` : ''),
    };
  }

  const result = await getJson(
    `${YASNO}/group?${query({ streetId: picked.match.id, houseId: found.id })}`
  );
  if (!Number.isFinite(result?.group)) {
    return { ok: false, error: 'Yasno не повернув групу для цієї адреси.' };
  }

  return {
    ok: true,
    group: `${result.group}.${result.subgroup ?? 1}`,
    address: `${picked.match.value}, ${found.value}`,
  };
}
