import { checkSecret, env } from '../lib/env.js';
import { acquireRunLock, releaseRunLock } from '../lib/db.js';
import { runCheck } from '../lib/monitor.js';
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

  if (!(await acquireRunLock(env.maxRunSeconds))) {
    // Попередній виклик ще працює — виходимо, він усе перевірить сам.
    res.status(200).json({ ok: true, skipped: 'already running' });
    return;
  }

  try {
    const sweeps = await runSweeps({
      intervalMs: env.sweepInterval * 1000,
      budgetMs: env.maxRunSeconds * 1000,
      once,
      // Перевіряти нічого — далі крутитись сенсу немає.
      shouldStop: (sweep) => sweep.checked === 0,
      run: async () => {
        const { checked, transitions } = await runCheck();
        return {
          at: new Date().toISOString(),
          checked,
          transitions: transitions.map((item) => ({
            device: item.device.name,
            status: item.status,
          })),
        };
      },
    });

    res.status(200).json({
      ok: true,
      sweeps: sweeps.length,
      intervalSec: env.sweepInterval,
      tookMs: Date.now() - startedAt,
      detail: sweeps,
    });
  } catch (error) {
    console.error('[check]', error);
    res.status(500).json({ ok: false, error: String(error.message) });
  } finally {
    await releaseRunLock().catch(() => {});
  }
}
