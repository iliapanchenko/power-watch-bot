import { checkSecret } from '../lib/env.js';
import { runCheck } from '../lib/monitor.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (!checkSecret(req)) {
    res.status(401).json({ error: 'bad secret' });
    return;
  }

  try {
    const { checked, transitions } = await runCheck();
    res.status(200).json({
      ok: true,
      checked,
      transitions: transitions.map((item) => ({
        device: item.device.name,
        status: item.status,
      })),
      at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[check]', error);
    res.status(500).json({ ok: false, error: String(error.message) });
  }
}
