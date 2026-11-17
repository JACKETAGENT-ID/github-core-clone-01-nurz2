// util.ts — small shared helpers: base64, ids, text diff, deterministic clock.
// No external dependencies; Node 22 stdlib only.

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** base64url without padding (opaque global ids). */
export function b64uEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64uDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function b64Encode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

export function b64Decode(text: string): Buffer | null {
  const clean = text.replace(/\s+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** Deterministic clock: every timestamp derives from a monotonic sequence, never Date.now(). */
export class SeqClock {
  private seq = 0;
  private readonly baseEpochSec: number;
  constructor(baseEpochSec: number) {
    this.baseEpochSec = baseEpochSec;
  }
  /** Next epoch second (increments on every call). */
  nextEpoch(): number {
    this.seq += 1;
    return this.baseEpochSec + this.seq;
  }
  /** Next ISO-8601 UTC timestamp. */
  nextIso(): string {
    return new Date(this.nextEpoch() * 1000).toISOString();
  }
}

/**
 * Line diff (LCS, files here are small): returns {added, removed} line counts.
 * Used for pull-request file stats.
 */
export function diffLineCounts(oldText: string, newText: string): { added: number; removed: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0) return { added: b.length, removed: 0 };
  if (b.length === 0) return { added: 0, removed: a.length };
  // LCS via two rows.
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m] ?? 0;
  return { added: m - lcs, removed: n - lcs };
}

/** Split a path into segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}
