/**
 * Перевірити з поточної машини, чи взагалі відповідає адреса.
 *
 *   node scripts/probe-test.mjs my-home.ddns.net 443
 *   node scripts/probe-test.mjs            # прогнати вбудовані приклади
 *
 * Зверни увагу: результат зі свого комп'ютера і результат із хмари Vercel
 * можуть відрізнятись. Це лише швидка перевірка «а чи туди я взагалі стукаю».
 */
import { tcpProbe } from '../lib/probe.js';
import { humanDuration } from '../lib/format.js';

const [, , host, port = '443'] = process.argv;

const cases = host
  ? [[host, Number(port), 'вказаний хост']]
  : [
      ['1.1.1.1', 443, 'живий публічний хост'],
      ['192.168.253.254', 443, 'приватна адреса — має бути timeout'],
      ['127.0.0.1', 1, 'закритий локальний порт — ECONNREFUSED теж означає «живий»'],
      ['no-such-host-zzz.invalid', 443, 'неіснуючий домен'],
    ];

for (const [target, targetPort, label] of cases) {
  const startedAt = Date.now();
  const result = await tcpProbe(target, targetPort, 4000);
  console.log(
    `${result.alive ? '🟢 живий ' : '🔴 тиша  '} ${target}:${targetPort}` +
      `  detail=${result.detail}` +
      `  latency=${result.latency ?? '—'}мс` +
      `  (зайняло ${Date.now() - startedAt}мс)  — ${label}`
  );
}

if (!host) {
  console.log('\nФормат тривалостей:');
  for (const seconds of [5, 59, 61, 125, 3600, 8500, 86400 * 2 + 3600 * 5]) {
    console.log(`  ${String(seconds).padStart(7)} с -> ${humanDuration(seconds)}`);
  }
}
