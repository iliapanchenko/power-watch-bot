import { checkSecret, env } from '../lib/env.js';
import { acquireLock, releaseLock, saveStatus } from '../lib/store.js';
import {
  loadWorld,
  sweep,
  notify,
  maybeSendSummaries,
  pruneStatus,
  countDevices,
} from '../lib/monitor.js';
import { runSweeps } from '../lib/sweep.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (!checkSecret(req)) {
    res.status(401).json({ error: 'bad secret' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const once = url.searchParams.get('once') === '1';
  const startedAt = Date.now();

  if (!(await acquireLock(env.maxRunSeconds))) {
    // Попередній виклик ще працює — виходимо, він усе перевірить сам.
    res.status(200).json({ ok: true, skipped: 'already running' });
    return;
  }

  try {
    const world = await loadWorld();
    pruneStatus(world);
    const devices = countDevices(world);

    const sweeps = await runSweeps({
      intervalMs: env.sweepInterval * 1000,
      budgetMs: env.maxRunSeconds * 1000,
      once,
      shouldStop: (result) => result.devices === 0,
      run: async () => {
        const byChat = await sweep(world);

        if (byChat.size > 0) {
          await notify(byChat);
          // Записуємо одразу після сповіщення, а не в кінці виклику: якщо
          // функція впаде посередині, наступна не надішле те саме вдруге.
          await saveStatus(world.status);
        }

        if (await maybeSendSummaries(world)) {
          await saveStatus(world.status);
        }

        return {
          at: new Date().toISOString(),
          devices,
          transitions: [...byChat.values()].flat().map((item) => ({
            device: item.device.name,
            status: item.to,
          })),
        };
      },
    });

    // Лічильники гістерезису змінюються щопроходу, тож зберігаємо в кінці
    // навіть тоді, коли статуси нікуди не рухались.
    if (devices > 0) await saveStatus(world.status);

    res.status(200).json({
      ok: true,
      chats: world.chats.length,
      devices,
      sweeps: sweeps.length,
      intervalSec: env.sweepInterval,
      tookMs: Date.now() - startedAt,
      detail: sweeps,
    });
  } catch (error) {
    console.error('[check]', error);
    res.status(500).json({ ok: false, error: String(error.message) });
  } finally {
    await releaseLock().catch(() => {});
  }
}
