import { env } from '../lib/env.js';
import { handleMessage } from '../lib/commands.js';
import { handleCallback } from '../lib/callbacks.js';
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

  // Відповідаємо 200 у будь-якому разі: інакше Telegram ретраїтиме
  // той самий апдейт по колу.
  try {
    await route(req.body ?? {});
  } catch (error) {
    console.error('[webhook]', error);
  }

  res.status(200).json({ ok: true });
}

async function route(update) {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  // У каналах команда приходить як channel_post, а не message.
  const message = update.message ?? update.channel_post;
  if (!message?.chat?.id) return;

  try {
    const reply = await handleMessage(message);
    if (!reply) return;

    // Обробник віддає або готовий рядок, або екран із клавіатурою.
    const { text, reply_markup } = typeof reply === 'string' ? { text: reply } : reply;
    await sendMessage(message.chat.id, text, reply_markup ? { reply_markup } : {});
  } catch (error) {
    console.error('[webhook]', error);
    await sendMessage(
      message.chat.id,
      `Щось пішло не так: <code>${String(error.message).slice(0, 300)}</code>`
    ).catch(() => {});
  }
}
