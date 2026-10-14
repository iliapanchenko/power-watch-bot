/**
 * Прогін закріплення графіка на справжніх даних ДТЕК, з підробленими
 * Telegram і Redis. Показує, що бот робитиме в чаті протягом доби.
 *
 *   node scripts/preview-schedule.mjs
 *
 * Потрібен інтернет: графік береться з того самого дзеркала, що й у бота.
 */

process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.BOT_TOKEN = '1:fake';

const realFetch = globalThis.fetch;
const store = new Map();
const chat = [];
let nextId = 100;
let actions = 0;

globalThis.fetch = async (url, init) => {
  const target = String(url);

  if (target.includes('api.telegram.org')) {
    actions += 1;
    const method = target.split('/').pop();
    const body = JSON.parse(init.body);
    let result = true;
    if (method === 'sendMessage') {
      result = { message_id: nextId++ };
      chat.push({ id: result.message_id, text: body.text });
      const sound = body.disable_notification ? ' беззвучно' : '';
      log(`надіслано${sound} #${result.message_id}` + (/^[⏰🚨✅]/u.test(body.text) ? ': ' + plain(body.text).split('\n')[0] : ''));
    } else if (method === 'pinChatMessage') log(`закріплено #${body.message_id}`);
    else if (method === 'unpinChatMessage') log(`відкріплено #${body.message_id}`);
    else if (method === 'deleteMessage') log(`видалено #${body.message_id}`);
    else if (method === 'editMessageText') log(`тихо переписано #${body.message_id}`);
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  }

  if (target.includes('upstash.io')) {
    const [cmd, key, value] = JSON.parse(init.body);
    const result = cmd === 'set' ? (store.set(key, value), 'OK') : store.get(key) ?? null;
    return { ok: true, json: async () => ({ result }) };
  }

  return realFetch(url, init);
};

const { runSchedules } = await import('../lib/schedule-runner.js');
const { kyivLocalToMs, absoluteIntervals } = await import('../lib/schedule.js');

const plain = (html) => html.replace(/<\/?(b|i)>/g, '');
let clock = '';
const log = (line) => console.log(`  ${clock}  ${line}`);

const world = {
  chats: [{ id: -1001, devices: [], schedule: { region: 'kyiv', group: '4.1', address: 'вул. Олеся Олександра, 2А' } }],
  status: { devices: {}, summaries: {}, schedules: {} },
  schedules: {},
};

async function step(label, now) {
  clock = new Date(now).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
  console.log(`\n\x1b[2m── ${label}\x1b[0m`);
  const before = actions;
  await runSchedules(world, now);
  if (actions === before) log('нічого не робить');
}

const today = Number(Object.keys(JSON.parse(await (await realFetch(
  'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json'
)).text()).fact.data)[0]) * 1000;
const at = (h, m = 0) => kyivLocalToMs(today, h * 60 + m);

await step('16:00, адресу щойно вказали', at(16, 0));
console.log('\n' + plain(chat.at(-1).text).replace(/^/gm, '  │ '));

await step('16:10, наступна перевірка', at(16, 10));

// Найближче справжнє відключення з живих даних — під нього й попередження.
const upcoming = absoluteIntervals(world.schedules.kyiv.days, '4.1').find((i) => i.start > at(16, 10));
if (upcoming) {
  await step('за 25 хвилин до відключення', upcoming.start - 25 * 60000);
  await step('хвилиною пізніше, попередження вже було', upcoming.start - 24 * 60000);
}

// Далі дані підставляємо самі. Бот при кожному оновленні замінює об'єкт
// графіка новим, тому звертаємось до нього щоразу заново, а мітки часу
// ставимо свіжими, щоб бот не пішов по справжні дані й не затер підставлене.
const live = () => world.schedules.kyiv;
const freeze = (time, status) => {
  live().fetchedAt = time;
  live().status = { fetchedAt: time, groups: { '4.1': status } };
};

// ДТЕК публікує графік на завтра: дописуємо день, як це зробило б дзеркало.
live().days.push({
  date: new Date(today + 36 * 3600 * 1000).toISOString().slice(0, 10),
  start: today + 24 * 3600 * 1000,
  groups: { '4.1': 'yyyyyyyynnnyyyyyyyyyyyyy' },
});
freeze(at(20, 0), 'EmergencyShutdowns');
await step('20:00, з\'явився графік на завтра', at(20, 0));
console.log('\n' + plain(chat.at(-1).text).replace(/^/gm, '  │ '));

freeze(at(22, 0), 'ScheduleApplies');
await step('22:00, Yasno: екстрені відключення скасовано', at(22, 0));

freeze(at(23, 0), 'EmergencyShutdowns');
await step('23:00, Yasno: екстрені відключення знову', at(23, 0));

freeze(at(24, 1), 'EmergencyShutdowns');
await step('00:01, настала північ', at(24, 1));

world.chats[0].schedule = null;
await step('людина написала /schedule off', at(24, 5));

console.log('');
