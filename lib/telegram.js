import { env } from './env.js';

const API = `https://api.telegram.org/bot${env.token}`;

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function callApi(method, payload = {}) {
  return parseResponse(
    method,
    await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );
}

/**
 * Те саме, але з файлом: картинку Telegram приймає лише як multipart.
 * Поля-об'єкти (media, reply_markup) ідуть усередині форми JSON-рядком.
 */
async function callApiWithPhoto(method, payload, png) {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  form.append('photo', new Blob([png], { type: 'image/png' }), 'schedule.png');
  return parseResponse(method, await fetch(`${API}/${method}`, { method: 'POST', body: form }));
}

async function parseResponse(method, response) {
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

/**
 * Картинка з текстом над нею. Підпис — до 1024 символів, на відміну від
 * 4096 у звичайного повідомлення.
 */
export function sendPhoto(chatId, png, caption) {
  return callApiWithPhoto(
    'sendPhoto',
    { chat_id: chatId, caption, parse_mode: 'HTML', show_caption_above_media: true },
    png
  );
}

/** Замінити картинку разом із підписом. */
export function editPhoto(chatId, messageId, png, caption) {
  return callApiWithPhoto(
    'editMessageMedia',
    {
      chat_id: chatId,
      message_id: messageId,
      media: {
        type: 'photo',
        media: 'attach://photo',
        caption,
        parse_mode: 'HTML',
        show_caption_above_media: true,
      },
    },
    png
  );
}

/** Переписати лише підпис, картинку не чіпати. */
export function editCaption(chatId, messageId, caption) {
  return callApi('editMessageCaption', {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: 'HTML',
    show_caption_above_media: true,
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

/** Відомості про чат; pinned_message — найсвіжіше із закріплених. */
export function getChat(chatId) {
  return callApi('getChat', { chat_id: chatId });
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
