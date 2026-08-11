import net from 'node:net';

/**
 * Перевірка живості хоста через TCP-конект.
 *
 * ICMP-пінг у serverless недоступний (потрібні raw-сокети), тому стукаємо
 * у порт. Важливий нюанс: ECONNREFUSED та ECONNRESET означають, що на тому
 * кінці хтось є і відповів — тобто живлення Є, просто порт закритий.
 * «Світла нема» — це тиша, тобто таймаут або EHOSTUNREACH.
 *
 * @returns {Promise<{alive: boolean, latency: number|null, detail: string}>}
 */
export function tcpProbe(host, port, timeout = 4000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (alive, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ alive, latency: alive ? Date.now() - startedAt : null, detail });
    };

    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true, 'connect'));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => {
      const code = err.code ?? 'ERROR';
      finish(code === 'ECONNREFUSED' || code === 'ECONNRESET', code);
    });

    try {
      // family: 4 — та сама версія протоколу, яку перевіряє lib/hosts.js
      // при додаванні адреси.
      socket.connect({ host, port, family: 4 });
    } catch {
      finish(false, 'EBADHOST');
    }
  });
}

/** Кілька спроб поспіль: досить однієї вдалої, щоб вважати хост живим. */
export async function probeWithRetries(host, port, timeout, attempts = 2) {
  let last = { alive: false, latency: null, detail: 'unknown' };
  for (let i = 0; i < attempts; i += 1) {
    last = await tcpProbe(host, port, timeout);
    if (last.alive) return last;
  }
  return last;
}
