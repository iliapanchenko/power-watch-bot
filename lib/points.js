/**
 * Точка — це місце, де ми стежимо за світлом. Зазвичай її представляє один
 * датчик, але Wi-Fi-пристрої іноді на хвилини зникають з мережі, хоча
 * живлення в них є. Тому в однієї точки може бути кілька датчиків з
 * однаковою назвою, і світло вважається зниклим лише тоді, коли мовчать
 * усі одразу. Ймовірність, що два пристрої випадково відвалюються в ту
 * саму хвилину, мізерна; справжнє відключення гасить їх разом.
 */

export const deviceKey = (chatId, device) => `${chatId}|${device.host}:${device.port}`;

/** Назви порівнюються без урахування регістру й зайвих пробілів. */
export function sameName(a, b) {
  const norm = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Датчики чату, згруповані в точки, у порядку першої появи.
 *
 * Стан точки живе під ключем її першого датчика. Завдяки цьому точки з
 * одним датчиком, які існували до появи груп, зберігають свою історію
 * без жодної міграції.
 *
 * @returns {Array<{key: string, name: string, devices: Array<{device: object, index: number, key: string}>}>}
 */
export function groupPoints(chat) {
  const points = [];
  (chat.devices ?? []).forEach((device, index) => {
    const member = { device, index, key: deviceKey(chat.id, device) };
    const existing = points.find((point) => sameName(point.name, device.name));
    if (existing) existing.devices.push(member);
    else points.push({ key: member.key, name: device.name, devices: [member] });
  });
  return points;
}

/** Точка жива, якщо відповів хоч один її датчик. Невідомий датчик — не відповів. */
export function pointAlive(point, aliveByKey) {
  return point.devices.some(({ key }) => aliveByKey.get(key) === true);
}
