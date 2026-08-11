import { env } from './env.js';
import { loadAllChats, loadStatus, saveStatus, deleteChat } from './store.js';
import { probeWithRetries } from './probe.js';
import { sendMessage, escapeHtml } from './telegram.js';
import { applyProbe, closeDay, emptyState } from './status.js';
import { humanDuration, kyivNow } from './format.js';

export const deviceKey = (chatId, device) =>
  `${chatId}|${device.host}:${device.port}`;

/**
 * Увесь стан читається один раз на виклик функції, а не на кожен прохід.
 * Проходів чотири на хвилину, і якби кожен ходив у Redis, безкоштовного
 * ліміту команд вистачило б рівно до середини місяця.
 */
export async function loadWorld() {
  const [chats, status] = await Promise.all([loadAllChats(), loadStatus()]);
  return { chats, status };
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
      probe: await probeWithRetries(device.host, device.port, env.probeTimeout),
    }))
  );

  const byChat = new Map();

  for (const { chat, device, probe } of results) {
    const key = deviceKey(chat.id, device);
    const { state, transition } = applyProbe(
      world.status.devices[key] ?? emptyState(),
      probe.alive,
      now,
      { failThreshold: env.failThreshold, okThreshold: env.okThreshold }
    );

    state.latency = probe.latency;
    state.detail = probe.detail;
    state.checkedAt = now;
    world.status.devices[key] = state;

    if (!transition) continue;
    if (!byChat.has(chat.id)) byChat.set(chat.id, []);
    byChat.get(chat.id).push({ device, ...transition });
  }

  return byChat;
}

/** Розіслати сповіщення про переходи. Кожен чат отримує лише своє. */
export async function notify(byChat) {
  for (const [chatId, transitions] of byChat) {
    const text = transitions
      .map(({ device, to, durationSec }) => {
        const name = escapeHtml(device.name);
        if (to === 'down') {
          const tail =
            durationSec == null ? '' : `\nСвітло було ${humanDuration(durationSec)}.`;
          return `🔴 <b>${name}</b> — світло зникло.${tail}`;
        }
        const tail =
          durationSec == null ? '' : `\nБез світла було ${humanDuration(durationSec)}.`;
        return `🟢 <b>${name}</b> — світло з'явилось.${tail}`;
      })
      .join('\n\n');

    await deliver(chatId, text);
  }
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

    const lines = chat.devices.map((device) => {
      const key = deviceKey(chat.id, device);
      const { state, downSec } = closeDay(world.status.devices[key], now);
      world.status.devices[key] = state;

      const name = escapeHtml(device.name);
      return downSec === 0
        ? `🟢 <b>${name}</b> — світло було весь день`
        : `🔴 <b>${name}</b> — без світла ${humanDuration(downSec)}`;
    });

    world.status.summaries[chat.id] = date;
    await deliver(chat.id, `<b>Підсумок дня</b>\n\n${lines.join('\n')}`);
    sent = true;
  }

  return sent;
}

/** Чат, який заблокував бота, видаляється — інакше стукатимемось вічно. */
async function deliver(chatId, text) {
  try {
    await sendMessage(chatId, text);
  } catch (error) {
    const message = String(error.message);
    console.error(`[notify] чат ${chatId}: ${message}`);
    if (/403|blocked|kicked|chat not found|deactivated/i.test(message)) {
      await deleteChat(chatId).catch(() => {});
    }
  }
}
