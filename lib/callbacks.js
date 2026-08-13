import { isAdmin } from './env.js';
import { loadChat, saveChat, loadSettings, saveSettings } from './store.js';
import { resolveMode, resolveTempo } from './presets.js';
import { modeScreen, tempoScreen } from './commands.js';
import {
  answerCallback,
  deleteMessage,
  editMessage,
  getChatMember,
} from './telegram.js';

/**
 * Натискання кнопок під повідомленням.
 *
 * Головне тут — перевірка прав. Кнопку під дописом у каналі бачить кожен
 * підписник, і без перевірки будь-хто міг би перемкнути чутливість усьому
 * каналу. Telegram передає в натисканні автора, тому питаємо в нього ж,
 * ким ця людина є в цьому чаті.
 */

const MANAGERS = new Set(['creator', 'administrator']);

async function canManageChat(chatId, userId) {
  // Приватний чат: id чату і є id людини, питати нема кого.
  if (String(chatId) === String(userId)) return true;

  try {
    const member = await getChatMember(chatId, userId);
    return MANAGERS.has(member?.status);
  } catch (error) {
    console.error(`[callback] не вдалось перевірити права: ${error.message}`);
    return false;
  }
}

export async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const userId = query.from?.id;
  const [kind, value] = String(query.data ?? '').split(':');

  if (!chatId || !messageId) {
    await answerCallback(query.id, 'Це повідомлення застаріле.');
    return;
  }

  const chat = await loadChat(chatId);
  if (!chat) {
    await answerCallback(query.id, 'Цей чат не підписаний. Напишіть /start');
    return;
  }

  if (kind === 'mode') return applyMode(query, chat, value, userId, messageId);
  if (kind === 'tempo') return applyTempo(query, chat, value, userId, messageId);

  await answerCallback(query.id, 'Не знаю такої кнопки.');
}

async function applyMode(query, chat, value, userId, messageId) {
  if (!(await canManageChat(chat.id, userId))) {
    await answerCallback(query.id, 'Налаштування міняють лише адміністратори чату.');
    return;
  }

  const chosen = resolveMode(value);
  if (!chosen) {
    await answerCallback(query.id, 'Такого режиму немає.');
    return;
  }

  const settings = await loadSettings();
  const tempo = resolveTempo(settings.tempo);

  if (chat.mode !== chosen) {
    chat.mode = chosen;
    await saveChat(chat);
  }

  await answerCallback(query.id, `Чутливість: ${chosen}`);
  await dismiss(chat.id, messageId, modeScreen(chat, tempo));
}

async function applyTempo(query, chat, value, userId, messageId) {
  // Темп спільний для всіх чатів, тому адміністратора каналу тут замало.
  if (!isAdmin(userId)) {
    await answerCallback(query.id, 'Темп опитування налаштовує лише власник бота.');
    return;
  }

  const chosen = resolveTempo(value);
  if (!chosen) {
    await answerCallback(query.id, 'Такого темпу немає.');
    return;
  }

  const settings = await loadSettings();
  if (settings.tempo !== chosen) {
    await saveSettings({ ...settings, tempo: chosen });
  }

  await answerCallback(query.id, `Темп: ${chosen}`);
  await dismiss(chat.id, messageId, tempoScreen(chosen));
}

/**
 * Вибір зроблено — екран прибирається.
 *
 * Це службове повідомлення, і в каналі воно висить перед очима всіх
 * підписників. Підтвердженням служить спливна підказка, яку бачить лише
 * той, хто натиснув.
 *
 * Якщо видалити не вдалось (у бота немає права або повідомлення застаре),
 * лишаємо екран на місці, але перемальовуємо — щоб натискання бодай не
 * виглядало проігнорованим.
 */
async function dismiss(chatId, messageId, screen) {
  try {
    await deleteMessage(chatId, messageId);
    return;
  } catch (error) {
    console.error(`[callback] не вдалось видалити екран: ${error.message}`);
  }

  try {
    await editMessage(chatId, messageId, screen.text, screen.reply_markup);
  } catch (error) {
    // Натиснули на вже активний пресет — текст не змінився, і Telegram
    // відмовляється перемальовувати. Це не помилка.
    if (!/message is not modified/i.test(error.message)) {
      console.error(`[callback] не вдалось перемалювати: ${error.message}`);
    }
  }
}
