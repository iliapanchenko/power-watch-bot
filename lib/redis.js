/**
 * Мінімальний клієнт Upstash Redis поверх їхнього REST API.
 *
 * Пакет @upstash/redis робить те саме, але тут потрібні лише GET, SET, SADD
 * і кілька сусідів — заради них тягнути залежність немає сенсу. Заразом
 * видно, скільки саме команд ми витрачаємо: безкоштовний тариф рахує саме їх.
 */

const url = (
  process.env.KV_REST_API_URL ??
  process.env.UPSTASH_REDIS_REST_URL ??
  ''
).replace(/\/$/, '');

const token =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? '';

if (!url || !token) {
  throw new Error(
    'Немає доступу до Redis. Підключи Upstash у Vercel → Storage, ' +
      'або задай UPSTASH_REDIS_REST_URL і UPSTASH_REDIS_REST_TOKEN.'
  );
}

async function post(path, body) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

/** Одна команда: command('get', 'key') */
export async function command(...args) {
  const data = await post('', args.map(String));
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

/**
 * Кілька команд одним HTTP-запитом. Тарифікуються вони все одно поштучно,
 * але мережевий round-trip лишається один — а це головне, коли функція
 * живе всього хвилину.
 */
export async function pipeline(commands) {
  if (commands.length === 0) return [];
  const data = await post(
    '/pipeline',
    commands.map((args) => args.map(String))
  );
  return data.map((item) => {
    if (item.error) throw new Error(`Redis: ${item.error}`);
    return item.result;
  });
}

export function parseJson(raw, fallback = null) {
  if (raw == null) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
