import { command, pipeline, parseJson } from './redis.js';

const KEY = {
  chats: 'pw:chats',
  chat: (chatId) => `pw:chat:${chatId}`,
  status: 'pw:status',
  settings: 'pw:settings',
  lock: 'pw:lock',
};

/**
 * Конфіг чатів і поточні статуси лежать окремо не для краси.
 * Конфіг пише тільки вебхук (користувач додав адресу), статуси — тільки
 * cron. Якби це був один ключ, перевірка, що почалась до /add і
 * завершилась після, затерла б щойно додану адресу.
 */

export async function listChatIds() {
  const ids = await command('smembers', KEY.chats);
  return (ids ?? []).map(Number).filter(Number.isFinite);
}

export async function countChats() {
  return Number(await command('scard', KEY.chats)) || 0;
}

export async function loadChat(chatId) {
  return parseJson(await command('get', KEY.chat(chatId)));
}

/** Усі чати одним round-trip: SMEMBERS, далі один MGET. */
export async function loadAllChats() {
  const ids = await listChatIds();
  if (ids.length === 0) return [];

  const raw = await command('mget', ...ids.map(KEY.chat));
  return (raw ?? [])
    .map((item) => parseJson(item))
    .filter((chat) => chat && Array.isArray(chat.devices));
}

export async function saveChat(chat) {
  await pipeline([
    ['set', KEY.chat(chat.id), JSON.stringify(chat)],
    ['sadd', KEY.chats, chat.id],
  ]);
}

export async function deleteChat(chatId) {
  await pipeline([
    ['del', KEY.chat(chatId)],
    ['srem', KEY.chats, chatId],
  ]);
}

/**
 * Перенести чат на новий id. Потрібно, коли Telegram підвищує звичайну
 * групу до супергрупи — id при цьому змінюється, і без переносу людина
 * втратила б усі свої адреси разом зі старим ключем.
 */
export async function migrateChat(oldId, newId) {
  const chat = await loadChat(oldId);
  if (!chat) return null;

  chat.id = newId;
  await saveChat(chat);
  await deleteChat(oldId);
  return chat;
}

export async function loadStatus() {
  const raw = parseJson(await command('get', KEY.status), null);
  return {
    devices: raw?.devices ?? {},
    summaries: raw?.summaries ?? {},
  };
}

export async function saveStatus(status) {
  await command('set', KEY.status, JSON.stringify(status));
}

/**
 * Статуси й глобальні налаштування одним MGET.
 * Окремими GET це коштувало б зайвої команди на кожен виклик функції —
 * дрібниця, але безкоштовний тариф рахує саме команди.
 */
export async function loadStatusAndSettings() {
  const [rawStatus, rawSettings] = (await command('mget', KEY.status, KEY.settings)) ?? [];
  const status = parseJson(rawStatus, null);

  return {
    status: {
      devices: status?.devices ?? {},
      summaries: status?.summaries ?? {},
    },
    settings: parseJson(rawSettings, null) ?? {},
  };
}

/** Глобальні налаштування пише лише вебхук, читає лише cron. */
export async function loadSettings() {
  return parseJson(await command('get', KEY.settings), null) ?? {};
}

export async function saveSettings(settings) {
  await command('set', KEY.settings, JSON.stringify(settings));
}

/**
 * Один прохід за раз. Виклик живе майже хвилину, cron стукає щохвилини —
 * без замка два виклики накладуться й пришлють по два однакових сповіщення.
 */
export async function acquireLock(seconds) {
  const result = await command('set', KEY.lock, Date.now(), 'nx', 'ex', seconds);
  return result === 'OK';
}

export async function releaseLock() {
  await command('del', KEY.lock);
}
