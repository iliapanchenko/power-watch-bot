import { lookup } from 'node:dns/promises';

/**
 * Перевірка адреси перед тим, як узяти її під нагляд.
 *
 * Дві різні причини:
 *   1. Практична — приватну адресу з хмари не видно, вона вічно виглядатиме
 *      мертвою, і людина отримає нескінченне «світла нема».
 *   2. Безпекова — бот відкритий для родичів, а це означає, що будь-хто
 *      зможе змусити його стукати в довільну адресу. Внутрішня мережа
 *      і сервіси метаданих туди потрапляти не повинні.
 */

const BLOCKED_V4 = [
  { cidr: '0.0.0.0/8', why: 'зарезервований діапазон' },
  { cidr: '10.0.0.0/8', why: 'приватна мережа' },
  { cidr: '100.64.0.0/10', why: 'CGNAT провайдера' },
  { cidr: '127.0.0.0/8', why: 'localhost' },
  { cidr: '169.254.0.0/16', why: 'link-local і сервіси метаданих' },
  { cidr: '172.16.0.0/12', why: 'приватна мережа' },
  { cidr: '192.0.0.0/24', why: 'службовий діапазон' },
  { cidr: '192.0.2.0/24', why: 'документаційний діапазон' },
  { cidr: '192.168.0.0/16', why: 'домашня мережа' },
  { cidr: '198.18.0.0/15', why: 'тестовий діапазон' },
  { cidr: '198.51.100.0/24', why: 'документаційний діапазон' },
  { cidr: '203.0.113.0/24', why: 'документаційний діапазон' },
  { cidr: '224.0.0.0/4', why: 'мультикаст' },
  { cidr: '240.0.0.0/4', why: 'зарезервований діапазон' },
];

function toInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** @returns {string|null} причина блокування або null, якщо адреса нормальна */
export function blockedReason(ip) {
  const value = toInt(ip);
  if (value === null) return 'не схоже на IPv4-адресу';

  for (const { cidr, why } of BLOCKED_V4) {
    const [base, bits] = cidr.split('/');
    const mask = bits === '0' ? 0 : (-1 << (32 - Number(bits))) >>> 0;
    if ((value & mask) === (toInt(base) & mask)) return why;
  }
  return null;
}

export function isValidHostname(host) {
  return (
    typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-zA-Z0-9.-]+$/.test(host) &&
    !host.startsWith('-') &&
    !host.endsWith('-')
  );
}

/**
 * Резолвить ім'я і перевіряє, куди воно веде. Саме резолв, а не regex по
 * рядку: `myhome.example.com` цілком може вказувати на 192.168.1.1.
 *
 * @returns {Promise<{ok: true, ip: string} | {ok: false, error: string}>}
 */
export async function resolveAndValidate(host) {
  if (!isValidHostname(host)) {
    return { ok: false, error: 'Хост виглядає дивно. Очікую IPv4 або доменне ім\'я.' };
  }

  let ip;
  try {
    // family: 4 — бо сам конект теж піде по IPv4. Інакше перевіряли б одну
    // адресу, а стукали в іншу.
    ({ address: ip } = await lookup(host, { family: 4 }));
  } catch {
    return {
      ok: false,
      error: `Не вдалось визначити адресу для <code>${host}</code>. Перевір написання, або що ім'я справді існує.`,
    };
  }

  const reason = blockedReason(ip);
  if (reason) {
    return {
      ok: false,
      error:
        `<code>${host}</code> веде на <code>${ip}</code> — це ${reason}.\n\n` +
        'Такі адреси з інтернету недосяжні, бот бачив би вічне «світла нема». ' +
        "Потрібен білий IP від провайдера або DDNS-ім'я.",
    };
  }

  return { ok: true, ip };
}
