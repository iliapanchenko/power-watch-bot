import { env } from './env.js';
import {
  loadAllChats,
  loadStatusAndSettings,
  saveStatus,
  deleteChat,
  migrateChat,
} from './store.js';
import { modeThresholds } from './presets.js';
import { REGIONS } from './schedule-source.js';
import { scheduledOff } from './schedule-runner.js';
import { overlapSeconds } from './schedule.js';
import { probeWithRetries } from './probe.js';
import { sendMessage } from './telegram.js';
import { applyProbe, closeDay, emptyState } from './status.js';
import { kyivNow } from './format.js';
import { renderDailyReport, renderTransition } from './messages.js';

import { deviceKey, groupPoints, pointAlive } from './points.js';

/**
 * Увесь стан читається один раз на виклик функції, а не на кожен прохід.
 * Проходів чотири на хвилину, і якби кожен ходив у Redis, безкоштовного
 * ліміту команд вистачило б рівно до середини місяця.
 */
export async function loadWorld() {
  // Графіки регіонів читаються тим самим MGET, що й статуси: зайвої команди
  // Redis на кожен виклик це не додає.
  const [chats, rest] = await Promise.all([
    loadAllChats(),
    loadStatusAndSettings(Object.keys(REGIONS)),
  ]);
  return { chats, status: rest.status, settings: rest.settings, schedules: rest.schedules };
}

/** Викинути статуси адрес, які вже ніхто не відстежує. */
export function pruneStatus(world) {
  // Стан ведеться по точках, а відповіді — по кожному датчику окремо.
  const points = new Set();
  const sensors = new Set();
  for (const chat of world.chats) {
    for (const point of groupPoints(chat)) {
      points.add(point.key);
      for (const { key } of point.devices) sensors.add(key);
    }
  }

  for (const key of Object.keys(world.status.devices)) {
    if (!points.has(key)) delete world.status.devices[key];
  }
  for (const key of Object.keys(world.status.probes ?? {})) {
    if (!sensors.has(key)) delete world.status.probes[key];
  }

  const chatIds = new Set(world.chats.map((chat) => String(chat.id)));
  for (const chatId of Object.keys(world.status.summaries)) {
    if (!chatIds.has(chatId)) delete world.status.summaries[chatId];
  }
  for (const chatId of Object.keys(world.status.schedules ?? {})) {
    if (!chatIds.has(chatId)) delete world.status.schedules[chatId];
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

  return applyResults(world, results, now);
}

/**
 * Друга половина проходу, вже без мережі: відповіді датчиків → стан точок
 * і переходи. Окремо, щоб її можна було ганяти тестами на вигаданих
 * відповідях.
 *
 * @returns {Map<number, Array>} переходи, згруповані за чатом
 */
export function applyResults(world, results, now = Date.now()) {
  // Що відповів кожен датчик окремо — для /list, щоб було видно, який
  // із них «засинає».
  const probes = (world.status.probes ??= {});
  const aliveByKey = new Map();
  for (const { chat, device, probe } of results) {
    const key = deviceKey(chat.id, device);
    aliveByKey.set(key, probe.alive);
    probes[key] = { alive: probe.alive, latency: probe.latency, detail: probe.detail, checkedAt: now };
  }

  const byChat = new Map();

  for (const chat of world.chats) {
    for (const point of groupPoints(chat)) {
      // Пороги свої в кожного чату: комусь потрібне сповіщення за пів хвилини,
      // комусь важливіше не будити на кожне блимання Wi-Fi.
      const previous = world.status.devices[point.key] ?? emptyState();
      const { state, transition } = applyProbe(
        previous,
        pointAlive(point, aliveByKey),
        now,
        modeThresholds(chat.mode)
      );

      // Відключення закінчилось — рахуємо, яка його частина припала на
      // графік. Для звіту дня: «за графіком» і «поза графіком».
      if (transition?.to === 'up' && previous.downSince != null) {
        const off = scheduledOff(world, chat);
        if (off) {
          state.downScheduledToday =
            (state.downScheduledToday ?? 0) + overlapSeconds(previous.downSince, now, off);
        }
      }

      state.checkedAt = now;
      world.status.devices[point.key] = state;

      if (!transition) continue;
      if (!byChat.has(chat.id)) byChat.set(chat.id, []);
      byChat.get(chat.id).push({ device: { name: point.name }, at: now, ...transition });
    }
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

  // Стан точок і відповіді датчиків ключуються однаково: «чат|хост:порт».
  for (const table of [world.status.devices, world.status.probes ?? {}]) {
    for (const key of Object.keys(table)) {
      if (!key.startsWith(prefix)) continue;
      table[`${newId}|${key.slice(prefix.length)}`] = table[key];
      delete table[key];
    }
  }

  // Ці два — просто по id чату. Без графіка бот після переїзду забув би,
  // що вже писав про екстрені відключення, і написав би вдруге.
  for (const table of [world.status.summaries, world.status.schedules ?? {}]) {
    if (table[oldId] === undefined) continue;
    table[newId] = table[oldId];
    delete table[oldId];
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

    const off = scheduledOff(world, chat);

    const entries = groupPoints(chat).map(({ key, name }) => {
      const previous = world.status.devices[key];

      // Відключення, що триває просто зараз, ще не закрите переходом, тож
      // його запланована частина рахується тут, до розрізання доби.
      let scheduledSec;
      if (off) {
        const ongoing =
          previous?.status === 'down' && previous.downSince != null
            ? overlapSeconds(previous.downSince, now, off)
            : 0;
        scheduledSec = (previous?.downScheduledToday ?? 0) + ongoing;
      }

      const { state, downSec, upSec } = closeDay(previous, now);
      state.downScheduledToday = 0;
      world.status.devices[key] = state;

      return {
        name,
        upSec,
        downSec,
        scheduledSec: scheduledSec == null ? undefined : Math.min(scheduledSec, downSec),
      };
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
