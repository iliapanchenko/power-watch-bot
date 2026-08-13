import { env, isAdmin } from './env.js';
import {
  loadChat,
  saveChat,
  deleteChat,
  countChats,
  loadStatus,
} from './store.js';
import { resolveAndValidate } from './hosts.js';
import { probeWithRetries } from './probe.js';
import { deviceKey } from './monitor.js';
import { escapeHtml } from './telegram.js';
import { formatTime, humanDuration, statusIcon, statusWord } from './format.js';
import { renderTodayReport } from './messages.js';

const HELP = `<b>Що я вмію</b>

/status — що зі світлом просто зараз
/today — скільки світла не було сьогодні
/check — перевірити негайно, не чекаючи планової перевірки
/list — мої адреси з деталями
/add адреса Назва — додати адресу
/rm номер — прибрати адресу
/stop — відписатись і видалити мої дані
/id — показати свій Telegram id

<b>Як я розумію, що світла нема</b>
Раз на ${env.sweepInterval} секунд я стукаю у вказану адресу. Тиша ${env.failThreshold} перевірки поспіль — пишу «світло зникло», ${env.okThreshold} відповіді поспіль — «світло з'явилось». Раз на добу о ${String(env.summaryHour).padStart(2, '0')}:${String(env.summaryMinute).padStart(2, '0')} надсилаю підсумок дня.

<b>Головне обмеження</b>
Адреса має бути видима з інтернету: білий IP від провайдера або DDNS-ім'я. Домашню 192.168.x.x я не побачу, і якщо провайдер тримає тебе за CGNAT — теж нічого не вийде.
І ще: я бачу зв'язок, а не електрику. Обрив у провайдера при живому світлі виглядатиме для мене так само, як відключення.`;

const OPEN_COMMANDS = new Set(['/start', '/help', '/id']);

/** @returns {Promise<string|null>} текст відповіді або null, якщо мовчимо */
export async function handleMessage(message) {
  const text = (message.text ?? '').trim();
  if (!text.startsWith('/')) return null;

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  const rest = args.join(' ').trim();

  if (command === '/id') {
    // У каналі допис публікує сам канал, автора в оновленні немає.
    const who =
      userId == null
        ? 'Тут допис публікує канал, тому особистого id не видно. Напиши /id боту в приватний чат.'
        : `Твій user id: <code>${userId}</code>`;
    return `${who}\nId цього чату: <code>${chatId}</code>`;
  }
  if (command === '/help') return HELP;
  if (command === '/start') return start(message, rest);

  const chat = await loadChat(chatId);
  if (!chat && !OPEN_COMMANDS.has(command)) {
    return env.inviteCode
      ? 'Спочатку треба зайти за кодом-запрошенням: <code>/start код</code>'
      : 'Спочатку напиши /start';
  }

  switch (command) {
    case '/status':
      return renderStatus(chat, await loadStatus());
    case '/today':
      return renderToday(chat, await loadStatus());
    case '/list':
      return renderList(chat, await loadStatus());
    case '/check':
      return liveCheck(chat);
    case '/add':
      return addDevice(chat, rest);
    case '/rm':
    case '/remove':
      return removeDevice(chat, rest);
    case '/stop':
      await deleteChat(chatId);
      return 'Відписав і видалив твої адреси. Щоб повернутись — /start' +
        (env.inviteCode ? ' із кодом.' : '');
    case '/admin':
      return isAdmin(userId) ? adminSummary() : 'Ця команда не для тебе.';
    default:
      return 'Не знаю такої команди. /help покаже список.';
  }
}

async function start(message, code) {
  const chatId = message.chat.id;
  const existing = await loadChat(chatId);
  if (existing) return `Ти вже в справі.\n\n${HELP}`;

  const admin = isAdmin(message.from?.id);
  if (env.inviteCode && code !== env.inviteCode && !admin) {
    return code
      ? 'Код не підходить. Попроси актуальний у того, хто дав тобі бота.'
      : 'Цей бот працює за запрошенням. Напиши <code>/start код</code>, де код тобі дали разом із посиланням.';
  }

  if (!admin && (await countChats()) >= env.maxChats) {
    return 'Зараз бот заповнений під зав\'язку. Напиши власнику — він підніме ліміт.';
  }

  await saveChat({
    id: chatId,
    title: message.chat.title ?? message.chat.username ?? null,
    devices: [],
    joinedAt: Date.now(),
  });

  return (
    'Готово, тепер я твій.\n\n' +
    'Додай адресу, за якою стежити:\n' +
    '<code>/add myhome.ddns.net Квартира</code>\n\n' +
    `Можна до ${env.maxDevicesPerChat} адрес.\n\n${HELP}`
  );
}

function renderStatus(chat, status) {
  if (chat.devices.length === 0) {
    return 'Жодної адреси ще не додано.\n<code>/add myhome.ddns.net Квартира</code>';
  }

  return chat.devices
    .map((device) => {
      const state = status.devices[deviceKey(chat.id, device)];
      const current = state?.status ?? 'unknown';
      const tail =
        current === 'unknown' || !state?.statusSince
          ? ''
          : ` — вже ${humanDuration((Date.now() - state.statusSince) / 1000)}`;
      return `${statusIcon[current]} <b>${escapeHtml(device.name)}</b>: ${statusWord[current]}${tail}`;
    })
    .join('\n');
}

function renderToday(chat, status) {
  if (chat.devices.length === 0) return 'Жодної адреси ще не додано.';

  const now = Date.now();

  const entries = chat.devices.map((device) => {
    const state = status.devices[deviceKey(chat.id, device)];

    let downSec = state?.downToday ?? 0;
    // Якщо світла нема просто зараз, поточне відключення теж рахуємо.
    if (state?.status === 'down' && state.downSince) {
      downSec += (now - state.downSince) / 1000;
    }
    const trackedSec = state?.dayStart ? (now - state.dayStart) / 1000 : 0;

    return { name: device.name, downSec, upSec: Math.max(0, trackedSec - downSec) };
  });

  return renderTodayReport(entries, now);
}

function renderList(chat, status) {
  if (chat.devices.length === 0) {
    return 'Жодної адреси ще не додано.\n<code>/add myhome.ddns.net Квартира</code>';
  }

  const lines = chat.devices.map((device, index) => {
    const state = status.devices[deviceKey(chat.id, device)];
    const current = state?.status ?? 'unknown';
    const parts = [
      `${statusIcon[current]} <code>${index + 1}</code> <b>${escapeHtml(device.name)}</b>`,
      `${escapeHtml(device.host)}:${device.port}`,
      `Остання перевірка: ${formatTime(state?.checkedAt)}` +
        (state?.latency != null ? ` (${state.latency} мс)` : ''),
    ];
    if (state?.detail && current === 'down') {
      parts.push(`Причина: <code>${escapeHtml(state.detail)}</code>`);
    }
    return parts.join('\n');
  });

  return `${lines.join('\n\n')}\n\nПрибрати: <code>/rm 1</code>`;
}

async function liveCheck(chat) {
  if (chat.devices.length === 0) return 'Жодної адреси ще не додано.';

  const results = await Promise.all(
    chat.devices.map(async (device) => ({
      device,
      probe: await probeWithRetries(device.host, device.port, env.probeTimeout),
    }))
  );

  const lines = results.map(({ device, probe }) => {
    const name = escapeHtml(device.name);
    return probe.alive
      ? `🟢 <b>${name}</b> — відповідає (${probe.latency} мс)`
      : `🔴 <b>${name}</b> — тиша (<code>${escapeHtml(probe.detail)}</code>)`;
  });

  return (
    `<b>Просто зараз</b>\n\n${lines.join('\n')}\n\n` +
    'Це разова проба. Офіційний статус міняється лише після кількох перевірок поспіль.'
  );
}

async function addDevice(chat, rest) {
  if (!rest) {
    return (
      'Формат: <code>/add myhome.ddns.net Квартира</code>\n\n' +
      'Можна вказати порт: <code>/add 178.12.34.56:80 Дача</code>. ' +
      'Без порту беру 443.'
    );
  }

  if (chat.devices.length >= env.maxDevicesPerChat) {
    return `Більше ${env.maxDevicesPerChat} адрес не можна. Прибери зайву через /rm.`;
  }

  const [target, ...nameParts] = rest.split(/\s+/);
  const [host, portPart] = target.split(':');
  const port = portPart ? Number(portPart) : 443;
  const name = nameParts.join(' ').trim() || host;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Порт має бути числом від 1 до 65535.';
  }
  if (name.length > 40) return 'Назва задовга, до 40 символів.';

  if (chat.devices.some((device) => device.host === host && device.port === port)) {
    return 'Ця адреса вже під наглядом.';
  }

  const check = await resolveAndValidate(host);
  if (!check.ok) return check.error;

  chat.devices.push({ host, port, name });
  await saveChat(chat);

  return (
    `Додав: <b>${escapeHtml(name)}</b> — <code>${escapeHtml(host)}:${port}</code>\n\n` +
    'Перша перевірка пройде за хвилину. Якщо адреса недосяжна ззовні, ' +
    'я одразу напишу, що світла нема — це означатиме, що проблема в адресі, а не в світлі.'
  );
}

async function removeDevice(chat, rest) {
  if (!rest) return 'Формат: <code>/rm 1</code>. Номери подивись у /list';
  if (chat.devices.length === 0) return 'Прибирати нема чого.';

  const index = Number(rest);
  let position = Number.isInteger(index) ? index - 1 : -1;

  if (position < 0) {
    position = chat.devices.findIndex(
      (device) =>
        device.host === rest || device.name.toLowerCase() === rest.toLowerCase()
    );
  }

  if (position < 0 || position >= chat.devices.length) {
    return 'Не знайшов такої адреси. Подивись /list';
  }

  const [removed] = chat.devices.splice(position, 1);
  await saveChat(chat);
  return `Прибрав: <b>${escapeHtml(removed.name)}</b>`;
}

async function adminSummary() {
  const [chats, status] = await Promise.all([countChats(), loadStatus()]);
  return (
    `<b>Стан бота</b>\n\n` +
    `Чатів: ${chats} із ${env.maxChats}\n` +
    `Адрес під наглядом: ${Object.keys(status.devices).length}\n` +
    `Ліміт на чат: ${env.maxDevicesPerChat}`
  );
}
