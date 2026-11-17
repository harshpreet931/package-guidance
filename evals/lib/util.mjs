// Shared helpers: arg parsing, fs, concurrency, stats. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';

export function parseArgs(argv, { booleans = [], aliases = {} } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    a = aliases[a] || a;
    if (a.startsWith('no-') && booleans.includes(a.slice(3))) { out[camel(a.slice(3))] = false; continue; }
    if (booleans.includes(a)) { out[camel(a)] = val === undefined ? true : val !== 'false'; continue; }
    if (val === undefined) {
      val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`--${a} needs a value`);
      i++;
    }
    out[camel(a)] = val;
  }
  return out;
}
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export const list = (s, dflt) => (s === undefined || s === true ? dflt : String(s).split(',').map((x) => x.trim()).filter(Boolean));

export function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
export function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
export function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

/** Recursively walk `root`, yielding relative file paths, skipping heavy/vendored dirs. */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'env', '.tox', '__pycache__', '.next', 'dist', 'build', '.turbo', '.cache', '.pnpm-store', '.yarn', 'coverage', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'site-packages']);
export function* walk(root, { maxDepth = 6, skip = SKIP_DIRS } = {}, rel = '', depth = 0) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      if (skip.has(e.name) || depth >= maxDepth) continue;
      yield* walk(root, { maxDepth, skip }, r, depth + 1);
    } else if (e.isFile()) yield r;
  }
}

export function copyDir(src, dst, { filter = () => true } = {}) {
  fs.cpSync(src, dst, { recursive: true, filter: (s) => filter(s) });
}

/** Run async fn over items with at most `n` in flight. Preserves order of results. */
export async function pool(items, n, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchRetry(url, opts = {}, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal, headers: { 'user-agent': 'package-guidance-evals/0.1', ...(opts.headers || {}) } });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status} ${url}`); }
      else return res;
    } catch (e) { clearTimeout(t); lastErr = e; }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastErr;
}

// ---------- stats ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Cluster bootstrap: resample clusters (prompts) with replacement, then apply `stat`
 * to the pooled observations. Returns [lo, hi] 95% percentile interval.
 * clusters: Array<Array<number>>
 */
export function bootstrapCI(clusters, stat, { B = 2000, seed = 1 } = {}) {
  const cs = clusters.filter((c) => c.length);
  if (!cs.length) return null;
  const rnd = mulberry32(seed);
  const vals = [];
  for (let b = 0; b < B; b++) {
    const pooled = [];
    for (let i = 0; i < cs.length; i++) pooled.push(...cs[Math.floor(rnd() * cs.length)]);
    const v = stat(pooled);
    if (v !== null && Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [quantile(vals, 0.025), quantile(vals, 0.975)];
}

/**
 * Paired cluster bootstrap for a difference guided − baseline. Each cluster is a prompt
 * holding {a: number[], b: number[]} (baseline, guided). Resamples prompts.
 */
export function bootstrapDeltaCI(clusters, stat, { B = 2000, seed = 2 } = {}) {
  const cs = clusters.filter((c) => c.a.length && c.b.length);
  if (!cs.length) return null;
  const rnd = mulberry32(seed);
  const vals = [];
  for (let b = 0; b < B; b++) {
    const A = [], G = [];
    for (let i = 0; i < cs.length; i++) { const c = cs[Math.floor(rnd() * cs.length)]; A.push(...c.a); G.push(...c.b); }
    const v = stat(G) - stat(A);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((x, y) => x - y);
  return [quantile(vals, 0.025), quantile(vals, 0.975)];
}

export const round = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);
export const DAY = 86400000;
