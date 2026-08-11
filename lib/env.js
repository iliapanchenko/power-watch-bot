function num(name, fallback, min = 1) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export const env = {
  token: (process.env.BOT_TOKEN ?? '').trim(),
  databaseUrl: (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '').trim(),
  cronSecret: (process.env.CRON_SECRET ?? '').trim(),
  adminIds: (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter(Number.isFinite),
  failThreshold: num('FAIL_THRESHOLD', 2),
  okThreshold: num('OK_THRESHOLD', 2),
  probeTimeout: num('PROBE_TIMEOUT', 4000, 500),
};

export function isAdmin(userId) {
  // Порожній список = обмежень немає.
  return env.adminIds.length === 0 || env.adminIds.includes(Number(userId));
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
