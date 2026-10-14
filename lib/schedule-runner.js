import { saveSchedule } from './store.js';
import { fetchRegionSchedule } from './schedule-source.js';
import {
  absoluteIntervals,
  classifyChange,
  dueWarnings,
  renderSchedule,
  scheduleSnapshot,
} from './schedule.js';
import {
  deleteMessage,
  editMessage,
  pinMessage,
  sendMessage,
  unpinMessage,
} from './telegram.js';
import { kyivTime } from './format.js';

// Дзеркало саме оновлюється раз на кілька хвилин, і файл важить ~300 КБ.
// Тягнути його щохвилини — марнувати і свій трафік, і чужий GitHub.
const REFRESH_MS = 10 * 60 * 1000;
const WARN_LEAD_MS = 30 * 60 * 1000;

/**
 * Один крок графіків на виклик функції: оновити дані за потреби, потім
 * для кожного чату з адресою — закріпити свіжий графік і попередити про
 * найближче відключення.
 *
 * @returns {Promise<boolean>} чи змінився стан, який треба зберегти
 */
export async function runSchedules(world, now = Date.now()) {
  const states = (world.status.schedules ??= {});
  let changed = false;

  const wanted = world.chats.filter((chat) => chat.schedule?.group);
  const regionsInUse = new Set(wanted.map((chat) => chat.schedule.region ?? 'kyiv'));

  for (const region of regionsInUse) await refreshIfStale(world, region, now);

  for (const chat of world.chats) {
    try {
      if (chat.schedule?.group) {
        if (await syncChat(world, chat, now)) changed = true;
      } else if (states[chat.id]) {
        // Людина вимкнула графік — прибираємо й закріплення.
        await retire(chat.id, states[chat.id]);
        delete states[chat.id];
        changed = true;
      }
    } catch (error) {
      console.error(`[schedule] чат ${chat.id}: ${error.message}`);
    }
  }

  return changed;
}

/** Сам графік лежить в окремому ключі Redis, тож стан чатів це не зачіпає. */
async function refreshIfStale(world, region, now) {
  const current = world.schedules?.[region];
  if (current && now - current.fetchedAt < REFRESH_MS) return;

  try {
    const fresh = await fetchRegionSchedule(region, now);
    world.schedules[region] = fresh;
    await saveSchedule(region, fresh);
  } catch (error) {
    // Старі дані лишаються в обігу, а мітка їхнього віку сама з'явиться
    // в закріпленому, коли вони стануть підозріло старими.
    console.error(`[schedule] ${region}: не вдалось оновити — ${error.message}`);
  }
}

async function syncChat(world, chat, now) {
  const states = world.status.schedules;
  const region = chat.schedule.region ?? 'kyiv';
  const cache = world.schedules?.[region];
  if (!cache) return false; // ще жодного разу не вдалось завантажити

  const group = chat.schedule.group;
  const snapshot = scheduleSnapshot(cache, group, now);
  const text = renderSchedule({
    group,
    address: chat.schedule.address,
    snapshot,
    cache,
    now,
  });

  const previous = states[chat.id];
  const next = { group, days: snapshot.days, text };
  const action = classifyChange(previous, next);
  let changed = false;

  if (action === 'new') {
    const sent = await sendMessage(chat.id, text);
    try {
      await pinMessage(chat.id, sent.message_id);
    } catch (error) {
      // Без права закріплювати допис усе одно лишається в чаті.
      console.error(`[schedule] чат ${chat.id}: не закріпилось — ${error.message}`);
    }
    if (previous?.messageId) await retire(chat.id, previous);

    states[chat.id] = { ...next, messageId: sent.message_id, warned: previous?.warned ?? [] };
    changed = true;
  } else if (action === 'edit') {
    try {
      await editMessage(chat.id, previous.messageId, text);
      states[chat.id] = { ...previous, ...next };
    } catch (error) {
      if (/message is not modified/i.test(error.message)) {
        states[chat.id] = { ...previous, ...next };
      } else {
        // Повідомлення видалили руками — наступний виклик надішле нове.
        console.error(`[schedule] чат ${chat.id}: не відредагувалось — ${error.message}`);
        states[chat.id] = { ...previous, messageId: null };
      }
    }
    changed = true;
  }

  if (await warn(chat, cache, states[chat.id], now)) changed = true;
  return changed;
}

/**
 * Попередження за 30 хвилин до запланованого відключення.
 * Лише про «точно немає», без «можливо»: людина має звикнути, що
 * попередження означає справжнє відключення.
 */
async function warn(chat, cache, state, now) {
  if (!state) return false;
  const intervals = absoluteIntervals(cache.days, chat.schedule.group, 'off');
  const due = dueWarnings(intervals, state.warned, now, WARN_LEAD_MS);

  // Пам'ятаємо лише майбутні й нещодавні початки, щоб список не ріс вічно.
  const before = state.warned?.length ?? 0;
  state.warned = (state.warned ?? []).filter((start) => Number(start) > now - 24 * 3600 * 1000);
  let changed = state.warned.length !== before;

  for (const { start, end } of due) {
    const minutes = Math.max(1, Math.round((start - now) / 60000));
    await sendMessage(
      chat.id,
      `⏰ Через ${minutes} хв, о ${kyivTime(start)}, за графіком вимкнуть світло\n` +
        `Повернуть о ${kyivTime(end)}`
    );
    state.warned.push(String(start));
    changed = true;
  }
  return changed;
}

/** Старе закріплення: відкріпити й видалити, щоб у чаті не лишалось застарілих графіків. */
async function retire(chatId, state) {
  if (!state?.messageId) return;
  await unpinMessage(chatId, state.messageId).catch(() => {});
  // Видалити можна лише повідомлення, молодші за 48 годин. Старіше просто
  // лишиться відкріпленим — гірше від цього нікому.
  await deleteMessage(chatId, state.messageId).catch(() => {});
}

/** Проміжки «точно немає світла» для групи чату — для звіту дня. */
export function scheduledOff(world, chat) {
  const group = chat.schedule?.group;
  const cache = world.schedules?.[chat.schedule?.region ?? 'kyiv'];
  if (!group || !cache) return null;
  return absoluteIntervals(cache.days, group, 'off');
}
