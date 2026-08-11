import { waitUntil } from '@vercel/functions';
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

  let world;
  try {
    world = await loadWorld();
    pruneStatus(world);
  } catch (error) {
    await releaseLock().catch(() => {});
    console.error('[check] не вдалось прочитати стан', error);
    res.status(500).json({ ok: false, error: String(error.message) });
    return;
  }

  const devices = countDevices(world);
  const work = runCycle(world, devices, once);

  if (once) {
    // Ручний запуск: чекаємо результат, щоб було що подивитись.
    const sweeps = await work;
    res.status(200).json({
      ok: true,
      mode: 'sync',
      chats: world.chats.length,
      devices,
      sweeps: sweeps.length,
      tookMs: Date.now() - startedAt,
      detail: sweeps,
    });
    return;
  }

  /*
   * Плановий запуск відповідає одразу, а проходи доганяє у фоні.
   *
   * Причина приземлена: у безкоштовного cron-job.org таймаут запиту 30
   * секунд, а виклик живе 55. Тримали б з'єднання — кожен запуск
   * рахувався б як провалений, і планувальник зрештою вимкнув би задачу.
   * waitUntil дозволяє віддати відповідь і продовжити роботу.
   */
  waitUntil(work);

  res.status(200).json({
    ok: true,
    mode: 'background',
    chats: world.chats.length,
    devices,
    plannedSweeps: devices === 0 ? 1 : Math.ceil(env.maxRunSeconds / env.sweepInterval),
    tookMs: Date.now() - startedAt,
  });
}

async function runCycle(world, devices, once) {
  try {
    const sweeps = await runSweeps({
      intervalMs: env.sweepInterval * 1000,
      budgetMs: env.maxRunSeconds * 1000,
      once,
      shouldStop: (result) => result.devices === 0,
      run: async () => {
        const byChat = await sweep(world);

        if (byChat.size > 0) {
          await notify(byChat, world);
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
    return sweeps;
  } catch (error) {
    console.error('[check]', error);
    return [];
  } finally {
    await releaseLock().catch(() => {});
  }
}
