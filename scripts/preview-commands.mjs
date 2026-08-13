/**
 * Показати, що бот відповідає на команди налаштувань.
 *
 *   node scripts/preview-commands.mjs
 *
 * Redis підроблений і живе в пам'яті, Telegram не викликається — це
 * превʼю текстів, а не інтеграційний тест.
 */

process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
process.env.BOT_TOKEN = '1:fake';
process.env.ADMIN_IDS = '246824599';

// --- Redis у пам'яті ---------------------------------------------------------

const store = new Map();
const sets = new Map();

function run([cmd, ...args]) {
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

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const payload = String(url).endsWith('/pipeline')
    ? body.map((args) => ({ result: run(args) }))
    : { result: run(body) };
  return { ok: true, json: async () => payload };
};

// --- сцена -------------------------------------------------------------------

const { handleMessage } = await import('../lib/commands.js');

const CHAT = { id: -1002222222222, type: 'channel', title: "Світло Кам'янець" };
const OWNER = { id: 246824599 };

function say(text, from = OWNER) {
  return handleMessage({ chat: CHAT, from, text });
}

function show(title, html) {
  const text = String(html)
    .replace(/<\/?(b|i|code|pre|u|s)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  console.log(`\n\x1b[2m── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}\x1b[0m`);
  for (const line of text.split('\n')) console.log('  ' + line);
}

await say('/start svitlo-bot-7526');
await say('/add 46.201.250.116:4700 Кам\'янець');

show('/settings — типові налаштування', await say('/settings'));
show('/mode — список чутливостей', await say('/mode'));
show('/mode спокійний', await say('/mode спокійний'));
show('/settings — після зміни', await say('/settings'));
show('/tempo — список темпів (власник)', await say('/tempo'));
show('/tempo частий', await say('/tempo частий'));
show('/settings — на швидкому темпі', await say('/settings'));
show('/tempo від звичайного користувача', await say('/tempo частий', { id: 111 }));
show('/mode нісенітниця', await say('/mode дуже швидкий'));

console.log('');
