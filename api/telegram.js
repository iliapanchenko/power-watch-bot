import { env } from '../lib/env.js';
import { handleMessage } from '../lib/commands.js';
import { sendMessage } from '../lib/telegram.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Telegram підписує кожен запит секретом, який ми задали в setWebhook.
  // Без цього будь-хто, хто знає URL, міг би слати боту фейкові апдейти.
  const signature = req.headers['x-telegram-bot-api-secret-token'];
  if (env.cronSecret && signature !== env.cronSecret) {
    res.status(401).json({ error: 'bad secret' });
    return;
  }

  const message = req.body?.message;
  if (!message?.chat?.id) {
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const reply = await handleMessage(message);
    if (reply) await sendMessage(message.chat.id, reply);
  } catch (error) {
    console.error('[webhook]', error);
    // Відповідаємо 200 у будь-якому разі: інакше Telegram буде ретраїти
    // той самий апдейт по колу.
    try {
      await sendMessage(
        message.chat.id,
        `Щось пішло не так: <code>${String(error.message).slice(0, 300)}</code>`
      );
    } catch {
      /* нічого не вдієш */
    }
  }

  res.status(200).json({ ok: true });
}
