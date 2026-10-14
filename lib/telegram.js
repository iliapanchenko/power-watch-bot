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
    const error = new Error(`Telegram ${method}: ${data.description ?? response.status}`);
    // parameters несе службові підказки — зокрема migrate_to_chat_id,
    // коли групу підвищили до супергрупи і її id змінився.
    error.parameters = data.parameters;
    error.code = data.error_code ?? response.status;
    throw error;
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

/** Спливна підказка над кнопкою. Telegram чекає на неї в межах кількох секунд. */
export function answerCallback(callbackId, text) {
  return callApi('answerCallbackQuery', { callback_query_id: callbackId, text });
}

/** Перемалювати вже надіслане повідомлення на місці. */
export function editMessage(chatId, messageId, text, replyMarkup) {
  return callApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** Тихо: закріплення не має будити людей, сповіщення дає сам допис. */
export function pinMessage(chatId, messageId) {
  return callApi('pinChatMessage', {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

export function unpinMessage(chatId, messageId) {
  return callApi('unpinChatMessage', { chat_id: chatId, message_id: messageId });
}

export function deleteMessage(chatId, messageId) {
  return callApi('deleteMessage', { chat_id: chatId, message_id: messageId });
}

/** Хто ця людина в цьому чаті: creator, administrator, member... */
export function getChatMember(chatId, userId) {
  return callApi('getChatMember', { chat_id: chatId, user_id: userId });
}

export function setWebhook(url, secretToken) {
  return callApi('setWebhook', {
    url,
    secret_token: secretToken,
    // Telegram зберігає цей список у себе й надсилає боту лише перелічене.
    // Усе інше мовчки відкидає — без помилок і без натяку, тому кожен
    // новий тип оновлення потребує повторного заходу на /api/setup.
    //   channel_post   — дописи в каналах
    //   callback_query — натискання на кнопки під повідомленням
    allowed_updates: ['message', 'channel_post', 'callback_query'],
    drop_pending_updates: true,
  });
}

export function setCommands() {
  return callApi('setMyCommands', {
    commands: [
      { command: 'status', description: 'Що зі світлом просто зараз' },
      { command: 'today', description: 'Скільки світла не було сьогодні' },
      { command: 'check', description: 'Перевірити негайно' },
      { command: 'schedule', description: 'Графік відключень ДТЕК' },
      { command: 'address', description: 'Графік для вулиці: /address вулиця будинок' },
      { command: 'list', description: 'Мої точки' },
      { command: 'add', description: 'Додати точку: /add IP:порт Назва' },
      { command: 'rm', description: 'Прибрати точку: /rm номер' },
      { command: 'mode', description: 'Чутливість до коротких провалів' },
      { command: 'settings', description: 'Поточні налаштування' },
      { command: 'stop', description: 'Відписатись і видалити дані' },
      { command: 'help', description: 'Довідка' },
    ],
  });
}
