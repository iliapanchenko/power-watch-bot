import { env } from './env.js';

const API = `https://api.telegram.org/bot${env.token}`;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function callApi(method, payload = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description ?? response.status}`);
  }
  return data.result;
}

export async function sendMessage(chatId, text, extra = {}) {
  return callApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

/**
 * Розсилка кільком чатам. Помилка одного чату не зриває решту;
 * 403 (бот заблокований) повертається окремо, щоб викликач міг відписати чат.
 */
export async function broadcast(chatIds, text) {
  const gone = [];
  for (const chatId of chatIds) {
    try {
      await sendMessage(chatId, text);
    } catch (error) {
      const message = String(error.message);
      if (message.includes('403') || /blocked|kicked|chat not found/i.test(message)) {
        gone.push(chatId);
      }
      console.error(`[telegram] чат ${chatId}: ${message}`);
    }
  }
  return gone;
}

export function setWebhook(url, secretToken) {
  return callApi('setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
}

export function setCommands() {
  return callApi('setMyCommands', {
    commands: [
      { command: 'status', description: 'Поточний стан усіх точок' },
      { command: 'check', description: 'Перевірити просто зараз' },
      { command: 'list', description: 'Список точок' },
      { command: 'history', description: 'Останні події' },
      { command: 'add', description: 'Додати точку: /add host[:port] Назва' },
      { command: 'rm', description: 'Видалити точку: /rm <id або host>' },
      { command: 'stop', description: 'Відписатись від сповіщень' },
      { command: 'help', description: 'Довідка' },
    ],
  });
}
