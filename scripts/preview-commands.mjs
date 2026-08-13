/**
 * Показати, що бот відповідає на команди налаштувань і на натискання кнопок.
 *
 *   node scripts/preview-commands.mjs
 *
 * Redis підроблений і живе в пам'яті, Telegram теж підроблений — це превʼю
 * текстів і перевірка прав, а не інтеграційний тест.
 */

process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.BOT_TOKEN = '1:fake';
process.env.ADMIN_IDS = '246824599';

// --- Redis у пам'яті ---------------------------------------------------------

const store = new Map();
const sets = new Map();

function redis([cmd, ...args]) {
  const name = String(cmd).toLowerCase();
  const [key, ...rest] = args;

  switch (name) {
    case 'get': return store.get(key) ?? null;
    case 'set': store.set(key, rest[0]); return 'OK';
    case 'del': store.delete(key); return 1;
    case 'mget': return [key, ...rest].map((k) => store.get(k) ?? null);
    case 'sadd': {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(String(rest[0]));
      return 1;
    }
    case 'srem': sets.get(key)?.delete(String(rest[0])); return 1;
    case 'smembers': return [...(sets.get(key) ?? [])];
    case 'scard': return sets.get(key)?.size ?? 0;
    default: throw new Error(`підроблений Redis не вміє ${name}`);
  }
}

// --- Telegram у пам'яті ------------------------------------------------------

/** Ким прикидається той, хто натиснув. Міняється по ходу сценарію. */
let memberStatus = 'administrator';
/** Чи має бот право видаляти повідомлення в цьому чаті. */
let canDelete = true;
const events = [];

function telegram(method, payload) {
  switch (method) {
    case 'getChatMember': return { status: memberStatus };
    case 'answerCallbackQuery':
      events.push({ toast: payload.text });
      return true;
    case 'editMessageText':
      events.push({ edited: payload.text, keyboard: payload.reply_markup });
      return {};
    case 'deleteMessage':
      if (!canDelete) return { error: 'not enough rights to delete a message' };
      events.push({ deleted: payload.message_id });
      return true;
    case 'sendMessage': return {};
    default: throw new Error(`підроблений Telegram не вміє ${method}`);
  }
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  const body = JSON.parse(init.body);

  if (target.includes('api.telegram.org')) {
    const method = target.split('/').pop();
    const result = telegram(method, body);
    // Так само, як справжній Bot API: відмова приходить у тілі відповіді.
    const payload = result?.error
      ? { ok: false, error_code: 400, description: result.error }
      : { ok: true, result };
    return { ok: true, status: 200, json: async () => payload };
  }

  const payload = target.endsWith('/pipeline')
    ? body.map((args) => ({ result: redis(args) }))
    : { result: redis(body) };
  return { ok: true, json: async () => payload };
};

// --- сцена -------------------------------------------------------------------

const { handleMessage } = await import('../lib/commands.js');
const { handleCallback } = await import('../lib/callbacks.js');

const CHAT = { id: -1002222222222, type: 'channel', title: "Світло Кам'янець" };
const OWNER = { id: 246824599 };
const STRANGER = { id: 555000111 };

const say = (text, from = OWNER) => handleMessage({ chat: CHAT, from, text });

async function press(data, from = OWNER) {
  events.length = 0;
  await handleCallback({
    id: 'cb1',
    data,
    from,
    message: { message_id: 42, chat: CHAT },
  });
  return events;
}

function plain(html) {
  return String(html)
    .replace(/<\/?(b|i|code|pre|u|s)>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function show(title, reply) {
  console.log(`\n\x1b[2m── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}\x1b[0m`);
  const { text, reply_markup } = typeof reply === 'string' ? { text: reply } : reply;
  for (const line of plain(text).split('\n')) console.log('  ' + line);
  for (const row of reply_markup?.inline_keyboard ?? []) {
    for (const button of row) console.log('  [ ' + button.text + ' ]');
  }
}

await say('/start svitlo-bot-7526');
await say("/add 46.201.250.116:4700 Кам'янець");

show('/mode — екран із кнопками', await say('/mode'));
show('/settings', await say('/settings'));

console.log('\n\x1b[2m── натискання «спокійний» адміністратором ──────\x1b[0m');
for (const event of await press('mode:спокійний')) {
  if (event.toast) console.log('  спливна підказка: ' + event.toast);
  if (event.deleted) console.log('  екран видалено з чату');
  if (event.edited) console.log('  ❌ екран лишився в чаті');
}

console.log('\n\x1b[2m── те саме, але бот не має права видаляти ──────\x1b[0m');
canDelete = false;
for (const event of await press('mode:швидкий')) {
  if (event.toast) console.log('  спливна підказка: ' + event.toast);
  if (event.deleted) console.log('  екран видалено з чату');
  if (event.edited) {
    console.log('  видалити не вдалось, тому перемальовано:');
    for (const row of event.keyboard?.inline_keyboard ?? []) {
      for (const button of row) console.log('    [ ' + button.text + ' ]');
    }
  }
}
canDelete = true;

console.log('\n\x1b[2m── те саме натискає підписник каналу ───────────\x1b[0m');
memberStatus = 'member';
for (const event of await press('mode:швидкий', STRANGER)) {
  if (event.toast) console.log('  спливна підказка: ' + event.toast);
  if (event.edited || event.deleted) console.log('  ❌ екран змінено, а не мав би');
}
memberStatus = 'administrator';

console.log('\n\x1b[2m── /tempo натискає не власник бота ─────────────\x1b[0m');
for (const event of await press('tempo:частий', STRANGER)) {
  if (event.toast) console.log('  спливна підказка: ' + event.toast);
  if (event.edited || event.deleted) console.log('  ❌ темп змінено, а не мав би');
}

console.log('\n\x1b[2m── /tempo натискає власник ─────────────────────\x1b[0m');
for (const event of await press('tempo:частий')) {
  if (event.toast) console.log('  спливна підказка: ' + event.toast);
  if (event.edited) {
    for (const line of plain(event.edited).split('\n')) console.log('  ' + line);
  }
}

show('/settings — після обох змін', await say('/settings'));
show('/mode нісенітниця', await say('/mode дуже швидкий'));

console.log('');
