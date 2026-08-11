import { checkSecret, env } from '../lib/env.js';
import { initSchema } from '../lib/db.js';
import { setCommands, setWebhook } from '../lib/telegram.js';

/**
 * Одноразова ініціалізація: створює таблиці, реєструє вебхук і меню команд.
 * Відкрий у браузері після деплою:
 *   https://<проєкт>.vercel.app/api/setup?key=<CRON_SECRET>
 */
export default async function handler(req, res) {
  if (!checkSecret(req)) {
    res.status(401).json({ error: 'bad secret' });
    return;
  }

  const host =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    req.headers['x-forwarded-host'] ??
    req.headers.host;
  const webhookUrl = `https://${host}/api/telegram`;

  try {
    await initSchema();
    await setWebhook(webhookUrl, env.cronSecret || undefined);
    await setCommands();
    res.status(200).json({
      ok: true,
      webhook: webhookUrl,
      hint: 'Тепер напиши боту /start у Telegram.',
    });
  } catch (error) {
    console.error('[setup]', error);
    res.status(500).json({ ok: false, error: String(error.message) });
  }
}
