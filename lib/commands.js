import { devices, events, subscribers } from './db.js';
import { env, isAdmin } from './env.js';
import { runCheck } from './monitor.js';
import { escapeHtml } from './telegram.js';
import {
  formatTime,
  humanDuration,
  secondsSince,
  statusIcon,
  statusWord,
} from './format.js';

const HELP = `<b>Що я вмію</b>

/status — стан усіх точок зараз
/check — перевірити негайно, не чекаючи планової перевірки
/list — список точок з деталями
/history — останні 15 подій
/add host[:port] Назва — додати точку
/rm &lt;id або host&gt; — прибрати точку
/stop — відписатись від сповіщень
/id — показати свій Telegram id

<b>Як я розумію, що світла нема</b>
Я стукаю у вказаний порт із хмари. Тиша ${env.failThreshold} перевірки поспіль — пишу «світло зникло», ${env.okThreshold} відповіді поспіль — «світло з'явилось».

<b>Важливо</b>
Адреса має бути доступна з інтернету: білий IP або DDNS-ім'я. Домашню 192.168.x.x з хмари не видно.
Я бачу лише «є зв'язок / нема зв'язку». Обрив у провайдера при живому світлі виглядатиме так само, як відключення.`;

const PRIVATE_RANGES =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

/** @returns {Promise<string|null>} текст відповіді або null, якщо мовчимо */
export async function handleMessage(message) {
  const text = (message.text ?? '').trim();
  if (!text.startsWith('/')) return null;

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  const rest = args.join(' ').trim();

  switch (command) {
    case '/start':
      await subscribers.add(chatId, message.chat.title ?? message.chat.username ?? null);
      return `Підписав цей чат на сповіщення.\n\n${HELP}`;

    case '/help':
      return HELP;

    case '/stop': {
      const [removed] = await subscribers.remove(chatId);
      return removed
        ? 'Відписав. Щоб повернутись — /start'
        : 'Цей чат і так не був підписаний.';
    }

    case '/id':
      return `Твій user id: <code>${userId}</code>\nId цього чату: <code>${chatId}</code>`;

    case '/status':
      return renderStatus(await devices.all());

    case '/list':
      return renderList(await devices.all());

    case '/check': {
      const { checked, transitions } = await runCheck();
      if (checked === 0) return 'Жодної точки ще не додано. /add host Назва';
      const summary = renderStatus(await devices.all());
      const note =
        transitions.length > 0 ? '' : '\n\nЗмін статусу немає.';
      return `Перевірив ${checked} ${checked === 1 ? 'точку' : 'точки'}.\n\n${summary}${note}`;
    }

    case '/add':
      if (!isAdmin(userId)) return 'Додавати точки дозволено лише адміністраторам.';
      return addDevice(rest);

    case '/rm':
    case '/remove':
      if (!isAdmin(userId)) return 'Видаляти точки дозволено лише адміністраторам.';
      return removeDevice(rest);

    case '/history':
      return renderHistory(await events.recent(15));

    default:
      return `Не знаю такої команди. ${'/help'} покаже список.`;
  }
}

function renderStatus(list) {
  if (list.length === 0) return 'Жодної точки ще не додано. /add host Назва';

  return list
    .map((device) => {
      const since = secondsSince(device.last_change);
      const tail =
        device.status === 'unknown' || since == null
          ? ''
          : ` — вже ${humanDuration(since)}`;
      return `${statusIcon[device.status]} <b>${escapeHtml(device.name)}</b>: ${statusWord[device.status]}${tail}`;
    })
    .join('\n');
}

function renderList(list) {
  if (list.length === 0) return 'Жодної точки ще не додано. /add host Назва';

  return list
    .map((device) => {
      const lines = [
        `${statusIcon[device.status]} <b>${escapeHtml(device.name)}</b> <code>#${device.id}</code>`,
        `${escapeHtml(device.host)}:${device.port}`,
        `Остання перевірка: ${formatTime(device.last_checked)}` +
          (device.last_latency != null ? ` (${device.last_latency} мс)` : ''),
      ];
      if (device.last_detail && device.status === 'down') {
        lines.push(`Причина: <code>${escapeHtml(device.last_detail)}</code>`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function renderHistory(list) {
  if (list.length === 0) return 'Подій ще не було.';

  return list
    .map((event) => {
      const icon = event.status === 'down' ? '🔴' : '🟢';
      const action = event.status === 'down' ? 'зникло' : "з'явилось";
      const duration =
        event.duration_sec != null
          ? ` (попередній стан тримався ${humanDuration(event.duration_sec)})`
          : '';
      return `${icon} ${formatTime(event.created_at)} — ${escapeHtml(event.device_name)}: ${action}${duration}`;
    })
    .join('\n');
}

async function addDevice(rest) {
  if (!rest) {
    return 'Формат: <code>/add my-home.ddns.net:443 Квартира</code>\nПорт можна не вказувати, тоді буде 443.';
  }

  const [target, ...nameParts] = rest.split(/\s+/);
  const [host, portPart] = target.split(':');
  const port = portPart ? Number(portPart) : 443;
  const name = nameParts.join(' ').trim() || host;

  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return 'Хост виглядає дивно. Очікую IPv4 або доменне ім\'я.';
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'Порт має бути числом від 1 до 65535.';
  }

  const [device] = await devices.add(host, port, name);

  const warning = PRIVATE_RANGES.test(host)
    ? '\n\n⚠️ Це адреса з приватного діапазону — з хмари вона недосяжна, і точка завжди виглядатиме мертвою. Потрібен білий IP або DDNS-ім\'я.'
    : '';

  return `Додав: <b>${escapeHtml(device.name)}</b> — <code>${escapeHtml(device.host)}:${device.port}</code>${warning}`;
}

async function removeDevice(rest) {
  if (!rest) return 'Формат: <code>/rm 3</code> або <code>/rm my-home.ddns.net</code>';

  const asId = Number(rest);
  const matches = Number.isInteger(asId)
    ? await devices.byId(asId)
    : await devices.find(rest);

  if (matches.length === 0) return 'Не знайшов такої точки. Подивись /list';
  if (matches.length > 1) {
    return `Під це підходить кілька точок, вкажи id:\n${matches
      .map((device) => `<code>#${device.id}</code> ${escapeHtml(device.name)}`)
      .join('\n')}`;
  }

  const [removed] = await devices.remove(matches[0].id);
  return `Прибрав: <b>${escapeHtml(removed.name)}</b>`;
}
