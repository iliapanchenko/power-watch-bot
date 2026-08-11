import { checkSecret, env } from '../lib/env.js';
import { setCommands, setWebhook } from '../lib/telegram.js';
import { command } from '../lib/redis.js';

/**
 * Одноразова ініціалізація: реєструє вебхук, меню команд і перевіряє,
 * що Redis узагалі відповідає.
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
    const pong = await command('ping');
    await setWebhook(webhookUrl, env.cronSecret || undefined);
    await setCommands();

    res.status(200).json({
      ok: true,
      webhook: webhookUrl,
      redis: pong,
      inviteCode: env.inviteCode ? 'увімкнено' : 'ВИМКНЕНО — бот відкритий для всіх',
      hint: 'Тепер напиши боту /start у Telegram.',
    });
  } catch (error) {
    console.error('[setup]', error);
    res.status(500).json({ ok: false, error: String(error.message) });
  }
}
