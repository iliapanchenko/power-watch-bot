function num(name, fallback, min = 1) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export const env = {
  token: (process.env.BOT_TOKEN ?? '').trim(),
  cronSecret: (process.env.CRON_SECRET ?? '').trim(),

  // Без коду бот нікого не пускає. Порожній код = вхід вільний,
  // але тоді будь-хто зможе змусити нас довбитись у довільну адресу.
  inviteCode: (process.env.INVITE_CODE ?? '').trim(),

  // Власники бота: бачать /admin і не обмежені кодом.
  adminIds: (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter(Number.isFinite),

  failThreshold: num('FAIL_THRESHOLD', 2),
  okThreshold: num('OK_THRESHOLD', 2),
  probeTimeout: num('PROBE_TIMEOUT', 4000, 500),

  // Cron не вміє інтервалів менших за хвилину, тому один виклик /api/check
  // робить кілька проходів поспіль із цією паузою між ними.
  sweepInterval: num('SWEEP_INTERVAL', 15, 5),
  // Скільки живе один виклик. Має бути менше за maxDuration у vercel.json,
  // інакше платформа вб'є функцію посеред проходу.
  maxRunSeconds: num('MAX_RUN_SECONDS', 55, 5),

  // Стеля навантаження. Кожна адреса — це TCP-конект чотири рази на хвилину
  // з інфраструктури Vercel, тож рости безмежно їй не можна.
  maxDevicesPerChat: num('MAX_DEVICES_PER_CHAT', 3),
  maxChats: num('MAX_CHATS', 25),

  // О котрій за Києвом підбивати підсумок дня.
  summaryHour: num('SUMMARY_HOUR', 23, 0),
  summaryMinute: num('SUMMARY_MINUTE', 59, 0),
};

export function isAdmin(userId) {
  return env.adminIds.includes(Number(userId));
}

/** Секрет приймається і як заголовок, і як ?key= — cron-job.org уміє обидва. */
export function checkSecret(req) {
  if (!env.cronSecret) return true;
  const auth = req.headers?.authorization ?? '';
  const header = req.headers?.['x-cron-secret'] ?? '';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = url.searchParams.get('key') ?? '';
  return (
    auth === `Bearer ${env.cronSecret}` ||
    header === env.cronSecret ||
    query === env.cronSecret
  );
}
