import { env } from './env.js';
import {
  loadAllChats,
  loadStatusAndSettings,
  saveStatus,
  deleteChat,
  migrateChat,
} from './store.js';
import { modeThresholds } from './presets.js';
import { probeWithRetries } from './probe.js';
import { sendMessage } from './telegram.js';
import { applyProbe, closeDay, emptyState } from './status.js';
import { kyivNow } from './format.js';
import { renderDailyReport, renderTransition } from './messages.js';

export const deviceKey = (chatId, device) =>
  `${chatId}|${device.host}:${device.port}`;

/**
 * Увесь стан читається один раз на виклик функції, а не на кожен прохід.
 * Проходів чотири на хвилину, і якби кожен ходив у Redis, безкоштовного
 * ліміту команд вистачило б рівно до середини місяця.
 */
export async function loadWorld() {
  const [chats, rest] = await Promise.all([loadAllChats(), loadStatusAndSettings()]);
  return { chats, status: rest.status, settings: rest.settings };
}

/** Викинути статуси адрес, які вже ніхто не відстежує. */
export function pruneStatus(world) {
  const alive = new Set();
  for (const chat of world.chats) {
    for (const device of chat.devices) alive.add(deviceKey(chat.id, device));
  }

  for (const key of Object.keys(world.status.devices)) {
    if (!alive.has(key)) delete world.status.devices[key];
  }

  const chatIds = new Set(world.chats.map((chat) => String(chat.id)));
  for (const chatId of Object.keys(world.status.summaries)) {
    if (!chatIds.has(chatId)) delete world.status.summaries[chatId];
  }
}

export function countDevices(world) {
  return world.chats.reduce((total, chat) => total + chat.devices.length, 0);
}

/**
 * Один прохід по всіх адресах усіх чатів.
 * Проби йдуть паралельно: послідовно 30 адрес по 4 секунди не вклались би
 * навіть в один крок сітки.
 *
 * @returns {Promise<Map<number, Array>>} переходи, згруповані за чатом
 */
export async function sweep(world, now = Date.now()) {
  const targets = [];
  for (const chat of world.chats) {
    for (const device of chat.devices) targets.push({ chat, device });
  }

  const results = await Promise.all(
    targets.map(async ({ chat, device }) => ({
      chat,
      device,
      probe: await probeWithRetries(
        device.host,
        device.port,
        env.probeTimeout,
        env.probeAttempts
      ),
    }))
  );

  const byChat = new Map();

  for (const { chat, device, probe } of results) {
    const key = deviceKey(chat.id, device);
    // Пороги свої в кожного чату: комусь потрібне сповіщення за пів хвилини,
    // комусь важливіше не будити на кожне блимання Wi-Fi.
    const { state, transition } = applyProbe(
      world.status.devices[key] ?? emptyState(),
      probe.alive,
      now,
      modeThresholds(chat.mode)
    );

    state.latency = probe.latency;
    state.detail = probe.detail;
    state.checkedAt = now;
    world.status.devices[key] = state;

    if (!transition) continue;
    if (!byChat.has(chat.id)) byChat.set(chat.id, []);
    byChat.get(chat.id).push({ device, at: now, ...transition });
  }

  return byChat;
}

/** Розіслати сповіщення про переходи. Кожен чат отримує лише своє. */
export async function notify(byChat, world) {
  for (const [chatId, transitions] of byChat) {
    await deliver(chatId, transitions.map(renderTransition).join('\n\n'), world);
  }
}

/**
 * Перевісити статуси й підсумки чату на новий id.
 * Без цього після підвищення групи до супергрупи адреси почали б життя
 * з чистого аркуша, і про триваюче відключення прилетіло б удруге.
 */
export function remapChatStatus(world, oldId, newId) {
  const prefix = `${oldId}|`;

  for (const key of Object.keys(world.status.devices)) {
    if (!key.startsWith(prefix)) continue;
    world.status.devices[`${newId}|${key.slice(prefix.length)}`] =
      world.status.devices[key];
    delete world.status.devices[key];
  }

  if (world.status.summaries[oldId] !== undefined) {
    world.status.summaries[newId] = world.status.summaries[oldId];
    delete world.status.summaries[oldId];
  }

  const chat = world.chats.find((item) => String(item.id) === String(oldId));
  if (chat) chat.id = newId;
}

/**
 * Підсумок доби, окремо для кожного чату — кожен бачить лише свої адреси.
 * Викликається на кожному проході, але спрацьовує раз на добу: захистом
 * служить записана дата останнього підсумку.
 */
export async function maybeSendSummaries(world, now = Date.now()) {
  const { date, hour, minute } = kyivNow(new Date(now));
  if (hour * 60 + minute < env.summaryHour * 60 + env.summaryMinute) return false;

  let sent = false;

  for (const chat of world.chats) {
    if (world.status.summaries[chat.id] === date) continue;
    if (chat.devices.length === 0) {
      world.status.summaries[chat.id] = date;
      continue;
    }

    const entries = chat.devices.map((device) => {
      const key = deviceKey(chat.id, device);
      const { state, downSec, upSec } = closeDay(world.status.devices[key], now);
      world.status.devices[key] = state;
      return { name: device.name, upSec, downSec };
    });

    world.status.summaries[chat.id] = date;
    await deliver(chat.id, renderDailyReport(entries, now), world);
    sent = true;
  }

  return sent;
}

/** Чат, який заблокував бота, видаляється — інакше стукатимемось вічно. */
async function deliver(chatId, text, world) {
  try {
    await sendMessage(chatId, text);
    return;
  } catch (error) {
    const newId = error.parameters?.migrate_to_chat_id;

    if (newId) {
      console.warn(`[notify] чат ${chatId} переїхав на ${newId}`);
      await migrateChat(chatId, newId).catch(() => {});
      if (world) remapChatStatus(world, chatId, newId);
      await sendMessage(newId, text).catch((retryError) =>
        console.error(`[notify] новий чат ${newId}: ${retryError.message}`)
      );
      return;
    }

    const message = String(error.message);
    console.error(`[notify] чат ${chatId}: ${message}`);
    if (/403|blocked|kicked|chat not found|deactivated/i.test(message)) {
      await deleteChat(chatId).catch(() => {});
    }
  }
}
