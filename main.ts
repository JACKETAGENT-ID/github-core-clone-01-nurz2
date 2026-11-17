// main.ts — the entry <-> env lifecycle: bind an ephemeral port on 0.0.0.0, tell the
// env the port, then poll until the env says the trial is over and exit 0.
// (Starter-faithful, with the one deliberate change: an explicit 0.0.0.0 bind so the
// entry never depends on IPv6 dual-stack behaviour in the trial sandbox.)

import { createApp } from './src/server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200, or 409 when another entry won). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      process.stderr.write(`[entry] register answered HTTP ${res.status}, retrying\n`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      process.stderr.write(`[entry] register failed (${err instanceof Error ? err.message : String(err)}), retrying\n`);
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const app = createApp(TOKEN);
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  app.setBaseUrl(`http://127.0.0.1:${address.port}`);
  process.stdout.write(`[entry] listening on 0.0.0.0:${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  app.server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
