import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PackageManager } from './format.ts';
import type { Ecosystem } from './registry.ts';

export const DEFAULT_COOLDOWN_DAYS = 7;

const read = (p: string) => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

/** Walk up from `dir` to find the nearest directory containing one of `names`. */
export function findUp(dir: string, names: string[]): string | null {
  let d = resolve(dir);
  for (;;) {
    for (const n of names) if (existsSync(join(d, n))) return join(d, n);
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

export function detectPackageManager(dir: string, eco: Ecosystem): PackageManager {
  if (eco === 'pypi') {
    if (findUp(dir, ['uv.lock'])) return 'uv';
    if (findUp(dir, ['poetry.lock'])) return 'poetry';
    const py = findUp(dir, ['pyproject.toml']);
    if (py && /\[tool\.uv\]/.test(read(py) ?? '')) return 'uv';
    if (py && /\[tool\.poetry\]/.test(read(py) ?? '')) return 'poetry';
    return 'pip';
  }
  const pkgJson = findUp(dir, ['package.json']);
  if (pkgJson) {
    const pm = /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/.exec(read(pkgJson) ?? '')?.[1];
    if (pm) return pm as PackageManager;
  }
  const lock = findUp(dir, ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']);
  if (lock?.endsWith('pnpm-lock.yaml')) return 'pnpm';
  if (lock?.endsWith('yarn.lock')) return 'yarn';
  if (lock?.includes('bun.lock')) return 'bun';
  return 'npm';
}

export function detectEcosystem(dir: string): Ecosystem {
  const js = findUp(dir, ['package.json']);
  const py = findUp(dir, ['pyproject.toml', 'requirements.txt', 'setup.py', 'uv.lock']);
  if (py && (!js || dirname(py).length > dirname(js).length)) return 'pypi';
  return 'npm';
}

export interface Cooldown { days: number; source: string; configured: boolean }

export type Unit = 'seconds' | 'minutes' | 'days';
const SECONDS: Record<Unit, number> = { seconds: 1, minutes: 60, days: 86_400 };

/**
 * Parse a release-age setting into days. Accepts a bare number in `bareUnit`, a short or friendly duration
 * ("7d", "7 days", "1 week", "24 hours", "90m") or an ISO 8601 duration ("P7D", "PT12H").
 */
export function durationDays(raw: string, bareUnit: Unit): number | null {
  const s = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) return (Number(s) * SECONDS[bareUnit]) / 86_400;
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(s);
  if (iso && s.length > 1 && s.toUpperCase() !== 'PT') {
    const [w, d, h, m, sec] = iso.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number];
    return w * 7 + d + h / 24 + m / 1440 + sec / 86_400;
  }
  const friendly = /^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i.exec(s);
  if (!friendly) return null;
  const n = Number(friendly[1]);
  const perDay: Record<string, number> = { s: 86_400, m: 1440, h: 24, d: 1, w: 1 / 7 };
  return n / perDay[friendly[2]!.toLowerCase()[0]!]!;
}

/** Where each package manager reads its release-age setting. Mirrors data/cooldown.json (verified 2026-11-16). */
export interface Setting { pm: PackageManager; eco: Ecosystem; file: string; format: 'ini' | 'yaml' | 'toml'; section: string | null; key: string; unit: Unit }
export const SETTINGS: Setting[] = [
  { pm: 'pnpm', eco: 'npm', file: 'pnpm-workspace.yaml', format: 'yaml', section: null, key: 'minimumReleaseAge', unit: 'minutes' },
  { pm: 'yarn', eco: 'npm', file: '.yarnrc.yml', format: 'yaml', section: null, key: 'npmMinimalAgeGate', unit: 'minutes' },
  { pm: 'bun', eco: 'npm', file: 'bunfig.toml', format: 'toml', section: 'install', key: 'minimumReleaseAge', unit: 'seconds' },
  { pm: 'npm', eco: 'npm', file: '.npmrc', format: 'ini', section: null, key: 'min-release-age', unit: 'days' },
  { pm: 'uv', eco: 'pypi', file: 'uv.toml', format: 'toml', section: null, key: 'exclude-newer', unit: 'days' },
  { pm: 'uv', eco: 'pypi', file: 'pyproject.toml', format: 'toml', section: 'tool.uv', key: 'exclude-newer', unit: 'days' },
  { pm: 'poetry', eco: 'pypi', file: 'poetry.toml', format: 'toml', section: 'solver', key: 'min-release-age', unit: 'days' },
];

/** First `key = value` / `key: value` in a config file, ignoring comments. Deliberately not a full TOML/YAML parser. */
export function configValue(text: string | null, key: string): string | null {
  if (!text) return null;
  const m = new RegExp(`^[ \\t]*${key.replace(/[.-]/g, '\\$&')}[ \\t]*[=:][ \\t]*(.+?)[ \\t]*$`, 'm').exec(text);
  return m?.[1]?.replace(/\s+#.*$/, '').trim() ?? null;
}

/** A TOML/INI table name with quotes and spacing removed: `[ tool."uv" ]` → `tool.uv`. */
export const tableName = (raw: string) => raw.split('.').map((p) => p.trim().replace(/^["']|["']$/g, '')).join('.');

/** Where a setting's value sits in the text: the raw value (quotes kept, comment dropped) and its offsets. */
export interface Found { value: string; start: number; end: number }

/**
 * The value of `key` in `section` (null = top level), section-aware but deliberately not a full parser:
 * TOML/INI tables (incl. `[x] # comment`, dotted keys), YAML top-level keys only. Handles LF and CRLF.
 */
export function findSetting(text: string | null, format: Setting['format'], section: string | null, key: string): Found | null {
  if (!text) return null;
  const want = section ? `${section}.${key}` : key;
  let table: string | null = null;
  let offset = 0;
  for (const raw of text.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    if (format !== 'yaml') {
      const header = /^\s*\[(\[)?\s*([^\[\]]+?)\s*\]\]?\s*(?:[#;].*)?$/.exec(line);
      if (header) { table = header[1] ? `[[${tableName(header[2]!)}]]` : tableName(header[2]!); continue; }
    }
    const m = format === 'yaml'
      ? /^(["']?)([A-Za-z0-9_.-]+)\1[ \t]*:[ \t]*(.*)$/.exec(line)
      : /^[ \t]*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(?:[ \t]*\.[ \t]*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const lineKey = format === 'yaml' ? m[2]! : tableName(m[1]!);
    const full = format === 'yaml' || table === null ? lineKey : `${table}.${lineKey}`;
    if (full !== want) continue;
    const rest = m[format === 'yaml' ? 3 : 2]!;
    const quoted = /^(["'])(?:(?!\1).)*\1/.exec(rest);
    const value = quoted ? quoted[0] : rest.replace(/[ \t]+[#;].*$/, '').replace(/^[#;].*$/, '').trimEnd();
    const start = lineStart + line.length - rest.length;
    return { value, start, end: start + value.length };
  }
  return null;
}

/** A configured value in days. `null` when it is absent, disabled (`false`) or not something we can read. */
export function settingDays(setting: Pick<Setting, 'key' | 'unit'>, value: string): { days: number; fixedDate: boolean } | null {
  const unquoted = value.trim().replace(/^["']|["']$/g, '');
  if (!unquoted || /^false$/i.test(unquoted)) return null;
  // uv also accepts an absolute timestamp: the cooldown is however old that cutoff is today.
  if (setting.key === 'exclude-newer' && /^\d{4}-\d{2}-\d{2}/.test(unquoted)) {
    const t = Date.parse(unquoted);
    return Number.isNaN(t) ? null : { days: Math.max(0, (Date.now() - t) / 86_400_000), fixedDate: true };
  }
  const days = durationDays(unquoted, setting.unit);
  return days === null ? null : { days: Math.round(days * 100) / 100, fixedDate: false };
}

/**
 * Find a release-age cooldown the project already configures (nearest file up the tree, as the managers do).
 * With `pm`, only the setting that package manager actually reads counts.
 */
export function detectCooldown(dir: string, eco: Ecosystem, pm?: PackageManager): Cooldown | null {
  for (const setting of SETTINGS.filter((x) => x.eco === eco && (!pm || x.pm === pm))) {
    const path = findUp(dir, [setting.file]);
    const found = findSetting(path && read(path), setting.format, setting.section, setting.key);
    const parsed = found && settingDays(setting, found.value);
    if (!parsed) continue;
    const source = `${setting.file} ${setting.key}${parsed.fixedDate ? ' (fixed date)' : ''}`;
    return { days: parsed.days, source, configured: true };
  }
  return null;
}

export function resolveCooldown(dir: string, eco: Ecosystem, flag?: string, pm?: PackageManager): Cooldown {
  if (flag !== undefined) {
    const d = durationDays(flag, 'days');
    if (d !== null) return { days: d, source: '--cooldown', configured: false };
  }
  const env = process.env.PACKAGE_GUIDANCE_COOLDOWN;
  if (env) {
    const d = durationDays(env, 'days');
    if (d !== null) return { days: d, source: 'PACKAGE_GUIDANCE_COOLDOWN', configured: false };
  }
  return detectCooldown(dir, eco, pm) ?? { days: DEFAULT_COOLDOWN_DAYS, source: 'default', configured: false };
}

/**
 * How to let one fresh security fix through the repo's own cooldown, per package manager (data/cooldown.json).
 * Exempt the exact version where the manager supports it, otherwise the package, and only until it settles.
 */
export function exemptHint(pm: PackageManager, name: string, version: string): string {
  const until = 'Remove the entry once the release is older than the cooldown.';
  switch (pm) {
    case 'pnpm': return `Your pnpm cooldown will refuse ${name}@${version}. Allow just this fix in pnpm-workspace.yaml: minimumReleaseAgeExclude: ['${name}@${version}']. ${until}`;
    case 'bun': return `Your bun cooldown will refuse ${name}@${version}. Allow just this fix in bunfig.toml [install]: minimumReleaseAgeExcludes = ["${name}@${version}"]. ${until}`;
    case 'npm': return `Your npm cooldown will refuse ${name}@${version}. Allow it in .npmrc (npm 11.17+): min-release-age-exclude[]=${name}. ${until}`;
    case 'yarn': return `Your yarn cooldown will refuse ${name}@${version}. Allow it in .yarnrc.yml: npmPreapprovedPackages: ["${name}"]. ${until}`;
    case 'uv': return `Your uv exclude-newer will refuse ${name} ${version}. Allow it: [tool.uv] exclude-newer-package = { ${name} = false }. ${until}`;
    case 'poetry': return `Your Poetry min-release-age will refuse ${name} ${version}. Allow it: [solver] min-release-age-exclude = "${name}". ${until}`;
    default: return `Your configured cooldown may refuse ${name} ${version}; allow this one security fix explicitly. ${until}`;
  }
}
