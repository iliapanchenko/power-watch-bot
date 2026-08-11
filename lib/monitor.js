import { env } from './env.js';
import { devices, events, subscribers } from './db.js';
import { probeWithRetries } from './probe.js';
import { broadcast, escapeHtml } from './telegram.js';
import { humanDuration, secondsSince } from './format.js';

/**
 * Одна перевірка всіх точок.
 *
 * Гістерезис: статус міняється лише після FAIL_THRESHOLD провалів або
 * OK_THRESHOLD успіхів поспіль. Без нього один загублений пакет посеред
 * ночі розбудив би всіх «світло зникло / світло є» за 30 секунд.
 */
export async function runCheck({ silent = false } = {}) {
  const list = await devices.all();
  if (list.length === 0) return { checked: 0, transitions: [] };

  const results = await Promise.all(
    list.map(async (device) => {
      const probe = await probeWithRetries(
        device.host,
        device.port,
        env.probeTimeout
      );
      return { device, probe };
    })
  );

  const transitions = [];

  for (const { device, probe } of results) {
    // Лічильники впираються в поріг, щоб не рости нескінченно за тижні аптайму.
    const failCount = probe.alive
      ? 0
      : Math.min(device.fail_count + 1, env.failThreshold);
    const okCount = probe.alive
      ? Math.min(device.ok_count + 1, env.okThreshold)
      : 0;

    let nextStatus = device.status;
    if (probe.alive && okCount >= env.okThreshold) nextStatus = 'up';
    if (!probe.alive && failCount >= env.failThreshold) nextStatus = 'down';

    const changed = nextStatus !== device.status;

    await devices.saveProbe({
      id: device.id,
      status: nextStatus,
      failCount,
      okCount,
      latency: probe.latency,
      detail: probe.detail,
      changed,
    });

    if (!changed) continue;

    // Перший в житті успішний контакт — не подія, точка просто вийшла на зв'язок.
    const isFirstContact = device.status === 'unknown' && nextStatus === 'up';
    const durationSec = secondsSince(device.last_change);

    await events.add(device.id, device.name, nextStatus, durationSec);

    if (!isFirstContact) {
      transitions.push({ device, status: nextStatus, durationSec });
    }
  }

  if (transitions.length > 0 && !silent) {
    await notify(transitions);
  }

  return { checked: list.length, transitions };
}

async function notify(transitions) {
  const chats = await subscribers.all();
  if (chats.length === 0) return;

  const text = transitions.map(renderTransition).join('\n\n');
  const gone = await broadcast(
    chats.map((chat) => chat.chat_id),
    text
  );

  // Чати, які заблокували бота, більше не смикаємо.
  for (const chatId of gone) {
    await subscribers.remove(chatId);
  }
}

function renderTransition({ device, status, durationSec }) {
  const name = escapeHtml(device.name);
  if (status === 'down') {
    const tail =
      durationSec == null
        ? ''
        : `\nСвітло було ${humanDuration(durationSec)}.`;
    return `🔴 <b>${name}</b> — світло зникло.${tail}`;
  }
  const tail =
    durationSec == null ? '' : `\nБез світла було ${humanDuration(durationSec)}.`;
  return `🟢 <b>${name}</b> — світло з'явилось.${tail}`;
}
