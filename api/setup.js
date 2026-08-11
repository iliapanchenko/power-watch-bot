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

  // Без токена Telegram відповів би 404 на неіснуючий шлях /bot/setWebhook,
  // і причина була б неочевидна.
  if (!env.token) {
    res.status(500).json({
      ok: false,
      error:
        'Не заданий BOT_TOKEN. Додай його у Vercel → Settings → Environment ' +
        'Variables (Production) і зроби Redeploy — змінні підхоплюються лише при збірці.',
    });
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
