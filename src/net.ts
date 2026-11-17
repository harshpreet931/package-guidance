import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from './version.ts';

const CACHE_DIR = process.env.PACKAGE_GUIDANCE_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'package-guidance');
const DEFAULT_TTL = 60 * 60 * 1000; // 1h
const TIMEOUT = Number(process.env.PACKAGE_GUIDANCE_TIMEOUT_MS) || 8000;

export const netOptions = { cache: process.env.PACKAGE_GUIDANCE_NO_CACHE !== '1' };

export class NotFound extends Error {}

interface CacheEntry { t: number; status: number; body: unknown }

async function readCache(key: string, ttl: number): Promise<CacheEntry | null> {
  if (!netOptions.cache) return null;
  try {
    const e = JSON.parse(await readFile(join(CACHE_DIR, key), 'utf8')) as CacheEntry;
    const age = Date.now() - e.t;
    // A timestamp from the future (clock change, corrupt file) would never expire.
    return age >= -60_000 && age < ttl && (e.status === 200 || e.status === 404) ? e : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, entry: CacheEntry) {
  if (!netOptions.cache) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    // Write then rename, so a concurrent reader never sees half a file.
    const tmp = join(CACHE_DIR, `${key}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, join(CACHE_DIR, key));
    if (Math.random() < 0.02) await prune();
  } catch {
    /* cache is best effort */
  }
}

/** Entries older than the longest TTL are dead weight; occasionally sweep them. */
async function prune(maxAgeMs = 2 * 24 * 3600e3) {
  const now = Date.now();
  for (const f of await readdir(CACHE_DIR)) {
    const p = join(CACHE_DIR, f);
    // Another process may remove the file between readdir and stat.
    await stat(p).then((st) => (now - st.mtimeMs > maxAgeMs ? rm(p, { force: true }) : undefined), () => undefined);
  }
}

/** GET/POST JSON with timeout + disk cache. Throws NotFound on 404 (cached too, briefly). */
export async function getJSON<T>(url: string, init: { body?: unknown; ttl?: number } = {}): Promise<T> {
  const key = createHash('sha1').update(url + (init.body ? JSON.stringify(init.body) : '')).digest('hex') + '.json';
  const ttl = init.ttl ?? DEFAULT_TTL;
  const cached = await readCache(key, ttl);
  if (cached) {
    if (cached.status === 404) throw new NotFound(url);
    return cached.body as T;
  }
  const res = await fetch(url, {
    method: init.body ? 'POST' : 'GET',
    headers: {
      'user-agent': `package-guidance/${VERSION} (+https://github.com/harshpreet931/package-guidance)`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 404) {
    await writeCache(key, { t: Date.now() - ttl + 5 * 60 * 1000, status: 404, body: null }); // remember 404s for 5 min
    throw new NotFound(url);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = (await res.json()) as T;
  await writeCache(key, { t: Date.now(), status: 200, body });
  return body;
}

/** Run async fn over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
