import { command, pipeline, parseJson } from './redis.js';

const KEY = {
  chats: 'pw:chats',
  chat: (chatId) => `pw:chat:${chatId}`,
  status: 'pw:status',
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
