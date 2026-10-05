import { log as _log } from './log.js';

const log = (msg: string, data?: Record<string, unknown>) => _log('clay', msg, data);

const RATE_LIMIT = 90;
const WINDOW_MS = 10_000;
const MAX_RETRIES = 4;

const timestamps: number[] = [];

function rateLimit() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
  if (timestamps.length >= RATE_LIMIT) {
    const sleepFor = timestamps[0] + WINDOW_MS - now;
    if (sleepFor > 0) {
      return new Promise(r => setTimeout(r, sleepFor));
    }
  }
  timestamps.push(now);
  return Promise.resolve();
}

export async function pushToClay(
  webhookUrl: string,
  rows: Record<string, unknown>[],
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    let success = false;
    let delay = 5000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await rateLimit();
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(row),
        });

        if (res.status === 429) {
          const retryAfter = parseFloat(res.headers.get('Retry-After') ?? String(delay / 1000));
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          delay = Math.min(delay * 2, 30_000);
          continue;
        }

        if (res.ok) {
          success = true;
          break;
        } else {
          log(`Push failed: ${res.status}`, { row: String(row.company_linkedin ?? '').slice(0, 60) });
          break;
        }
      } catch (err) {
        log(`Push error: ${err}`, { attempt });
        if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }

    if (success) sent++;
    else failed++;
  }

  log(`Pushed ${sent}/${sent + failed} rows to Clay`);
  return { sent, failed };
}
