/**
 * Кілька датчиків на одну точку: на вигаданих відповідях, без мережі.
 *
 *   node scripts/points-test.mjs
 */
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.BOT_TOKEN = '1:fake';

const { groupPoints, pointAlive, sameName, deviceKey } = await import('../lib/points.js');
const { applyResults, pruneStatus } = await import('../lib/monitor.js');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? '✅' : '❌'} ${label}` +
      (ok ? '' : `\n   отримав:  ${JSON.stringify(actual)}\n   очікував: ${JSON.stringify(expected)}`)
  );
}

// --- групування -------------------------------------------------------------

const floor = { host: '176.104.33.113', port: 4700, name: 'Варшавський' };
const guest = { host: '176.104.33.113', port: 4701, name: 'варшавський ' };
const dacha = { host: '46.201.250.116', port: 4700, name: 'Дача' };
const chat = { id: -100, mode: 'швидкий', devices: [floor, dacha, guest] };

const points = groupPoints(chat);
expect('однакова назва — одна точка, регістр і пробіли не важать', points.map((p) => p.name), ['Варшавський', 'Дача']);
expect('у точки обидва датчики, з їхніми номерами для /rm', points[0].devices.map((d) => d.index), [0, 2]);
expect('стан точки живе під ключем першого датчика', points[0].key, deviceKey(-100, floor));
expect('sameName', sameName(' Варшавський', 'варшавський'), true);

const alive = (pairs) => new Map(pairs.map(([device, value]) => [deviceKey(-100, device), value]));
expect('відповів хоч один — точка жива', pointAlive(points[0], alive([[floor, false], [guest, true]])), true);
expect('мовчать усі — точка мертва', pointAlive(points[0], alive([[floor, false], [guest, false]])), false);
expect('про датчик нічого не відомо — не рахується за живий', pointAlive(points[0], alive([[floor, false]])), false);

// --- проходи ----------------------------------------------------------------

const world = {
  chats: [chat],
  status: { devices: {}, summaries: {}, schedules: {}, probes: {} },
  schedules: {},
};

const STEP = 15000;
let clock = 0;
const events = [];

function sweep(floorAlive, guestAlive, dachaAlive = true) {
  clock += STEP;
  const results = [
    { chat, device: floor, probe: { alive: floorAlive, latency: floorAlive ? 40 : null, detail: floorAlive ? 'connect' : 'timeout' } },
    { chat, device: guest, probe: { alive: guestAlive, latency: guestAlive ? 40 : null, detail: guestAlive ? 'connect' : 'timeout' } },
    { chat, device: dacha, probe: { alive: dachaAlive, latency: 90, detail: 'connect' } },
  ];
  for (const [, list] of applyResults(world, results, clock)) {
    for (const item of list) events.push(`${item.device.name}: ${item.to}`);
  }
}

// Обидва живі — точка виходить на зв'язок мовчки.
sweep(true, true);
sweep(true, true);
expect('перший вихід на зв\'язок не є подією', events, []);

// Термостат у теплій підлозі «засинає» на 6 хвилин — 24 проходи.
for (let i = 0; i < 24; i += 1) sweep(false, true);
expect('один датчик мовчить 6 хвилин — тривоги нема', events, []);
expect('в /list видно, хто саме мовчить', world.status.probes[deviceKey(-100, floor)].alive, false);

// Справжнє відключення гасить обидва.
sweep(false, false);
sweep(false, false);
expect('мовчать обидва — світло зникло', events, ['Варшавський: down']);

// Повертається один — світла вже досить, щоб сказати «є».
sweep(true, false);
sweep(true, false);
expect('відповів хоч один — світло повернулось', events, ['Варшавський: down', 'Варшавський: up']);

expect('сусідня точка жила своїм життям', world.status.devices[deviceKey(-100, dacha)]?.status, 'up');

// --- прибирання -------------------------------------------------------------

chat.devices = [guest, dacha]; // прибрали перший датчик
pruneStatus(world);
expect('відповідь прибраного датчика прибрано', Object.keys(world.status.probes).includes(deviceKey(-100, floor)), false);
expect('відповідь того, що лишився, — на місці', Object.keys(world.status.probes).includes(deviceKey(-100, guest)), true);

console.log(failures === 0 ? '\nВсе зійшлось.' : `\nПровалів: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
