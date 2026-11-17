/**
 * `scan`: audit the dependencies a project already declares. Uses exact versions from the lockfile when it
 * can read one (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, uv.lock, poetry.lock, pip `-c`
 * constraints), otherwise what the declared range resolves to today. Small purpose-built readers, not full
 * TOML/YAML parsers: anything they can't read is reported as a warning, never silently dropped.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkMany, type CheckResult } from './check.ts';
import type { Args, Meta } from './cli.ts';
import { contextFor, exemptFor, exitFor, fail, toJSON } from './cli.ts';
import { c, renderHeader, renderResults } from './format.ts';
import { sanitize } from './osv.ts';
import { tableName } from './project.ts';
import { normalizeName, type Ecosystem } from './registry.ts';

export interface Declared {
  name: string;
  range: string;
  version: string | null;
  dev: boolean;
  /** Workspace member (relative path) the dependency belongs to; absent for the root manifest. */
  where?: string;
  /** Said alongside the result, e.g. that a dist-tag was checked as `latest`. */
  note?: string;
}

/** Text without a BOM; null when missing, a directory or unreadable. */
const read = (p: string): string | null => {
  try { return readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; }
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const lines = (text: string) => text.split(/\r?\n/);
const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
/** Local names reach the terminal: strip control characters (escape sequences) like registry text. */
const clean = (s: string) => (/[\u0000-\u001f\u007f-\u009f]/.test(s) ? sanitize(s) || '?' : s);
const CONFLICT = /^(<{7}|>{7}|={7})( |$)/m;

// ---------------------------------------------------------------- npm

/** Specs that don't come from the npm registry, so there is nothing to look up. */
const SKIP_RANGE = /^(workspace:|file:|link:|portal:|patch:|exec:|git|github:|gitlab:|bitbucket:|gist:|jsr:|https?:|catalog:|\.|\/|~|[A-Za-z]:[\\/])/;
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(#.*)?$/;
/** `next`, `beta`, `canary`: a dist-tag, not a range (`x`/`X` are wildcards). */
const DIST_TAG = /^(?![xX]$)[A-Za-z][\w.-]*$/;
const NPM_FIELDS = [['dependencies', false], ['devDependencies', true], ['optionalDependencies', false]] as const;

interface LockQuery { where: string; member: string | undefined; key: string; raw: string; name: string }
type LockLookup = (q: LockQuery) => string | null;

/** An exact version from a lockfile value (`4.17.20`, `4.17.20(react@18)`, `npm:react@18.3.1`); else null. */
function exact(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/^npm:(?:@[^/@]+\/)?[^@]+@/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/.exec(s)?.[0] ?? null;
}

function packageLock(text: string): LockLookup {
  const j = JSON.parse(text) as unknown;
  if (!isObj(j)) throw new Error('not a JSON object');
  const ver = (x: unknown) => (isObj(x) ? exact(x.version) : null);
  if (isObj(j.packages)) {
    const pk = j.packages;
    // A member's own copy is nested under it; otherwise it was hoisted to the root.
    return ({ where, key }) => ver(pk[`${where ? `${where}/` : ''}node_modules/${key}`]) ?? ver(pk[`node_modules/${key}`]);
  }
  const deps = isObj(j.dependencies) ? j.dependencies : {}; // lockfileVersion 1
  return ({ key }) => ver(deps[key]);
}

/** pnpm-lock.yaml: `importers:` (v6, v9) and the single-project top-level form (v5). */
function pnpmLock(text: string): LockLookup {
  const map = new Map<string, string>();
  let top = '';
  let importer = '';
  let section = '';
  let dep = '';
  for (const raw of lines(text)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = /^("[^"]*"|'[^']*'|[^:]+):\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const key = unquote(m[1]!);
    const value = unquote(m[2]!);
    const depSection = (s: string) => /^(dependencies|devDependencies|optionalDependencies)$/.test(s);
    if (indent === 0) { top = key; importer = '.'; section = top; continue; }
    if (top === 'importers') {
      if (indent === 2) { importer = key; section = ''; } else if (indent === 4) section = key;
      else if (indent === 6 && depSection(section)) { dep = key; if (exact(value)) map.set(`${importer}\0${dep}`, exact(value)!); }
      else if (indent === 8 && key === 'version' && dep && depSection(section)) { const v = exact(value); if (v) map.set(`${importer}\0${dep}`, v); }
    } else if (depSection(top) && indent === 2) { dep = key; if (exact(value)) map.set(`.\0${key}`, exact(value)!); }
    else if (depSection(top) && indent === 4 && key === 'version' && dep) { const v = exact(value); if (v) map.set(`.\0${dep}`, v); }
  }
  return ({ where, key }) => map.get(`${where || '.'}\0${key}`) ?? null;
}

/** yarn.lock, classic (`version "1.2.3"`) and berry (`version: 1.2.3`, `name@npm:range` descriptors). */
function yarnLock(text: string): LockLookup {
  const map = new Map<string, string>();
  let keys: string[] = [];
  for (const raw of lines(text)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    // Classic quotes each descriptor, berry quotes the whole list: `"a@npm:^1, a@npm:^1.2":`.
    if (!/^\s/.test(raw)) { keys = raw.replace(/:\s*$/, '').split(/,\s*/).map((k) => k.trim().replace(/^"|"$/g, '')); continue; }
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(raw);
    const v = m && exact(m[1]);
    if (v) for (const k of keys) map.set(k, v);
  }
  return ({ key, raw }) => map.get(`${key}@${raw}`) ?? map.get(`${key}@npm:${raw}`) ?? null;
}

/** JSON with trailing commas (bun.lock's JSONC) → JSON. */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') { inString = true; out += ch; }
    else if (ch === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200))) continue;
    else out += ch;
  }
  return out;
}

/** bun.lock (text): `packages: { "<name>": ["<name>@<version>", …], "<member>/<name>": … }`. */
function bunLock(text: string): LockLookup {
  const j = JSON.parse(stripTrailingCommas(text)) as unknown;
  if (!isObj(j) || !isObj(j.packages)) throw new Error('no "packages" table');
  const pk = j.packages;
  const ver = (x: unknown) => (Array.isArray(x) && typeof x[0] === 'string' ? exact(x[0].slice(x[0].lastIndexOf('@') + 1)) : null);
  return ({ member, key }) => (member ? ver(pk[`${member}/${key}`]) : null) ?? ver(pk[key]);
}

const NPM_LOCKS: [string, (text: string) => LockLookup][] = [
  ['package-lock.json', packageLock], ['npm-shrinkwrap.json', packageLock], ['pnpm-lock.yaml', pnpmLock], ['yarn.lock', yarnLock], ['bun.lock', bunLock],
];

function npmLock(dir: string, warnings: string[]): LockLookup | null {
  for (const [file, reader] of NPM_LOCKS) {
    const text = read(join(dir, file));
    if (text === null) continue;
    try {
      if (CONFLICT.test(text)) throw new Error('it has unresolved merge conflicts');
      return reader(text);
    } catch (e) {
      warnings.push(`Could not read ${file} (${(e as Error).message}); checking declared ranges instead of locked versions.`);
      return null;
    }
  }
  if (existsSync(join(dir, 'bun.lockb'))) warnings.push('bun.lockb is binary and is not read; checking declared ranges. `bun install --save-text-lockfile` writes a readable bun.lock.');
  return null;
}

/** Workspace globs from package.json `workspaces` (array or `{ packages }`) and pnpm-workspace.yaml. */
function workspacePatterns(dir: string, pkg: Record<string, unknown>): string[] {
  const ws = pkg.workspaces;
  const list = Array.isArray(ws) ? ws : isObj(ws) && Array.isArray(ws.packages) ? ws.packages : [];
  const out = list.filter((x): x is string => typeof x === 'string');
  const pnpm = read(join(dir, 'pnpm-workspace.yaml'));
  if (pnpm) {
    let inPackages = false;
    for (const raw of lines(pnpm)) {
      if (/^\S/.test(raw)) inPackages = /^packages\s*:/.test(raw);
      else if (inPackages) { const m = /^\s+-\s*(.+?)\s*(#.*)?$/.exec(raw); if (m) out.push(unquote(m[1]!)); }
    }
  }
  return out;
}

const subdirs = (d: string) => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => e.name);
  } catch { return []; }
};

/** Member directories (relative, `/`-separated) matching workspace globs (`*`, `**`, `!negation`). */
export function workspaceMembers(dir: string, patterns: string[]): string[] {
  const found = new Set<string>();
  const excluded = new Set<string>();
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const segs = raw.replace(/^!/, '').replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean);
    const hit = neg ? excluded : found;
    const walk = (rel: string, i: number, depth: number) => {
      if (depth > 8 || found.size > 2000) return;
      if (i === segs.length) { if (rel && existsSync(join(dir, rel, 'package.json'))) hit.add(rel); return; }
      const seg = segs[i]!;
      const at = (name: string) => (rel ? `${rel}/${name}` : name);
      if (seg === '**') {
        walk(rel, i + 1, depth);
        for (const s of subdirs(join(dir, rel))) walk(at(s), i, depth + 1);
      } else if (seg.includes('*')) {
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')}$`);
        for (const s of subdirs(join(dir, rel))) if (re.test(s)) walk(at(s), i + 1, depth + 1);
      } else walk(at(seg), i + 1, depth + 1);
    };
    walk('', 0, 0);
  }
  return [...found].filter((x) => !excluded.has(x)).sort();
}

function manifest(path: string, warnings: string[], label: string): Record<string, unknown> | null {
  const text = read(path);
  if (text === null) return null;
  try {
    const j = JSON.parse(text) as unknown;
    if (isObj(j)) return j;
    warnings.push(`${label} is not a JSON object; skipped.`);
  } catch (e) {
    warnings.push(`${label} is not valid JSON (${(e as Error).message}); skipped.`);
  }
  return null;
}

/** npm dependencies of the root manifest and every workspace member, with locked versions where known. */
export function declaredNpm(dir: string, warnings: string[] = []): Declared[] {
  const root = manifest(join(dir, 'package.json'), warnings, 'package.json');
  if (!root) return [];
  const members = workspaceMembers(dir, workspacePatterns(dir, root))
    .map((where) => ({ where, pkg: manifest(join(dir, where, 'package.json'), warnings, `${where}/package.json`) }))
    .filter((m): m is { where: string; pkg: Record<string, unknown> } => m.pkg !== null);
  const internal = new Set([root, ...members.map((m) => m.pkg)].map((p) => p.name).filter((n): n is string => typeof n === 'string'));
  const lock = npmLock(dir, warnings);
  const out: Declared[] = [];
  const seen = new Set<string>();
  for (const { where, pkg } of [{ where: '', pkg: root }, ...members]) {
    const member = typeof pkg.name === 'string' ? pkg.name : undefined;
    for (const [field, dev] of NPM_FIELDS) {
      const deps = pkg[field];
      if (deps === undefined) continue;
      if (!isObj(deps)) { warnings.push(`${where ? `${where}/` : ''}package.json "${field}" is not an object; skipped.`); continue; }
      for (const [key, rawValue] of Object.entries(deps)) {
        if (typeof rawValue !== 'string') continue;
        const raw = rawValue.trim();
        let name = key;
        let range = raw;
        const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(raw);
        if (alias) { name = alias[1]!; range = alias[2] ?? ''; }
        if (internal.has(key) || internal.has(name)) continue; // a workspace sibling, not a registry package
        if (SKIP_RANGE.test(range) || (!alias && GITHUB_SHORTHAND.test(range))) continue;
        const id = `${where}\0${name}`;
        if (seen.has(id)) continue; // listed in two sections: the first (runtime) wins
        seen.add(id);
        const version = lock?.({ where, member, key, raw, name }) ?? null;
        let note: string | undefined;
        if (!version && range !== 'latest' && DIST_TAG.test(range)) {
          note = `Declared as the "${range}" dist-tag, which can't be resolved offline; checked the latest release instead.`;
          range = '';
        }
        out.push({ name: clean(name), range: clean(range), version, dev, ...(where ? { where } : {}), ...(note ? { note } : {}) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Python

interface Spec { spec: string; dev: boolean; note?: string }

/**
 * The top-level strings of a TOML array starting at `from` (just after `[`). Honours quotes so `pkg[extra]`
 * is safe, and skips inline tables such as PEP 735 `{ include-group = "x" }` (the included group is scanned
 * on its own).
 */
function tomlStrings(text: string, from: number): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let cur = '';
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"') cur += text[++i] ?? '';
      else if (ch === quote) { if (depth === 0) out.push(cur); cur = ''; quote = null; }
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ']' && depth === 0) break;
  }
  return out;
}

const HEADER = /^\s*\[(\[)?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const KEY = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/;
const POETRY = /^tool\.poetry\.(?:group\.([^.]+)\.)?(dev-)?dependencies(?:\.(.+))?$/;

/** A Poetry dependency value → PEP 440 range; `null` for path/git/url deps (nothing to look up). */
function poetryValue(v: string): { range: string; note?: string } | null {
  const s = v.trim();
  if (/^["']/.test(s)) return { range: poetryRange(unquote(s.replace(/\s+#.*$/, ''))) };
  if (s.startsWith('{')) {
    if (/\b(path|git|url)\s*=/.test(s)) return null;
    return { range: poetryRange(/\bversion\s*=\s*["']([^"']*)["']/.exec(s)?.[1] ?? '*') };
  }
  if (s.startsWith('[')) return { range: '', note: 'Declared with several Python-specific constraints; checked the latest release.' };
  return { range: '' };
}

function pyproject(text: string, specs: Spec[], skip: Set<string>, reqFiles: { file: string; dev: boolean }[], warnings: string[]) {
  let section = '';
  let offset = 0;
  let pending: { name: string; dev: boolean; range: string; path: boolean } | null = null;
  const flush = () => {
    if (pending && !pending.path && pending.name.toLowerCase() !== 'python') specs.push({ spec: `${pending.name}${pending.range}`, dev: pending.dev });
    pending = null;
  };
  for (const raw of text.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.replace(/\r$/, '');
    const header = HEADER.exec(line);
    if (header) {
      flush();
      section = header[1] ? `[[${tableName(header[2]!)}]]` : tableName(header[2]!);
      const sub = POETRY.exec(section);
      if (sub?.[3]) pending = { name: unquote(sub[3]), dev: (!!sub[1] && sub[1] !== 'main') || !!sub[2], range: '', path: false };
      const src = /^tool\.uv\.sources\.(.+)$/.exec(section);
      if (src) skip.add(normalizeName('pypi', unquote(src[1]!)));
      continue;
    }
    const kv = KEY.exec(line);
    if (!kv) continue;
    const key = unquote(kv[1]!);
    const value = kv[2]!;
    if (value.startsWith('[')) {
      const strings = () => tomlStrings(text, lineStart + line.indexOf('[', line.indexOf('=')) + 1);
      if (section === 'project' && key === 'dependencies') for (const s of strings()) specs.push({ spec: s, dev: false });
      else if (section === 'project' && key === 'dynamic' && strings().includes('dependencies')) warnings.push('pyproject.toml declares its dependencies as dynamic; only the files [tool.setuptools.dynamic] names (if any) and requirements files are scanned.');
      else if (section === 'project.optional-dependencies' || section === 'dependency-groups' || (section === 'tool.uv' && key === 'dev-dependencies')) {
        for (const s of strings()) specs.push({ spec: s, dev: true });
      }
    }
    if (section === 'tool.uv.sources') skip.add(normalizeName('pypi', key));
    if (section === 'tool.setuptools.dynamic' && /^(dependencies|optional-dependencies\..+)$/.test(key)) {
      const files = /\bfile\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/.exec(value)?.[1] ?? '';
      for (const f of files.match(/"[^"]*"|'[^']*'/g) ?? []) reqFiles.push({ file: unquote(f), dev: key !== 'dependencies' });
    }
    const poetry = POETRY.exec(section);
    if (poetry && !poetry[3] && key.toLowerCase() !== 'python') {
      const v = poetryValue(value);
      if (v) specs.push({ spec: `${key}${v.range}`, dev: (!!poetry[1] && poetry[1] !== 'main') || !!poetry[2], ...(v.note ? { note: v.note } : {}) });
    }
    if (poetry?.[3] && pending) {
      if (key === 'version') pending.range = poetryRange(unquote(value.replace(/\s+#.*$/, '')));
      if (/^(path|git|url)$/.test(key)) pending.path = true;
    }
  }
  flush();
}

/** Poetry's `^1.2` / `~1.2` / `1.2.*` → PEP 440. */
function poetryRange(r: string): string {
  const s = r.trim();
  if (s === '*' || s === '') return '';
  const caret = /^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(s);
  if (caret) {
    const [a, b, c] = [Number(caret[1]), caret[2] === undefined ? undefined : Number(caret[2]), caret[3]];
    const upper = a > 0 || b === undefined ? `${a + 1}` : b > 0 || c === undefined ? `0.${b + 1}` : `0.0.${Number(c) + 1}`;
    return `>=${s.slice(1)},<${upper}`;
  }
  const tilde = /^~(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(s);
  if (tilde) return `>=${s.slice(1)},<${tilde[2] === undefined ? Number(tilde[1]) + 1 : `${tilde[1]}.${Number(tilde[2]) + 1}`}`;
  return /^[\d]/.test(s) ? `==${s}` : s;
}

/** Pipfile `[packages]` / `[dev-packages]`: values are already PEP 440 (`"*"`, `"==1.0"`, `{ version = … }`). */
function pipfile(text: string, specs: Spec[]) {
  let section = '';
  for (const line of lines(text)) {
    const header = HEADER.exec(line);
    if (header) { section = tableName(header[2]!); continue; }
    const kv = KEY.exec(line);
    if (!kv || (section !== 'packages' && section !== 'dev-packages')) continue;
    const v = kv[2]!.trim();
    if (v.startsWith('{') && /\b(path|git|file|editable)\s*=/.test(v)) continue;
    const range = v.startsWith('{') ? /\bversion\s*=\s*["']([^"']*)["']/.exec(v)?.[1] ?? '' : unquote(v.replace(/\s+#.*$/, ''));
    specs.push({ spec: `${unquote(kv[1]!)}${range === '*' ? '' : range}`, dev: section === 'dev-packages' });
  }
}

/** setup.cfg `[options] install_requires` and `[options.extras_require]` (indented continuation lines). */
function setupCfg(text: string, specs: Spec[]) {
  let section = '';
  let collecting: boolean | null = null; // dev flag while inside a multi-line value
  for (const line of lines(text)) {
    const header = HEADER.exec(line);
    if (header) { section = tableName(header[2]!); collecting = null; continue; }
    if (collecting !== null && /^\s+\S/.test(line)) {
      const s = line.replace(/(^|\s)[#;].*$/, '').trim();
      if (s) specs.push({ spec: s, dev: collecting });
      continue;
    }
    collecting = null;
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const dev = section === 'options.extras_require';
    if ((section === 'options' && kv[1] === 'install_requires') || dev) {
      collecting = dev;
      const s = kv[2]!.replace(/(^|\s)[#;].*$/, '').trim();
      if (s) specs.push({ spec: s, dev });
    }
  }
}

/**
 * requirements files: `-r` includes (relative to the including file, cycle-safe), `-c` constraints (used as
 * locked versions), `\` continuations, ` #` comments, per-line options such as `--hash`, CRLF. URL, path and
 * editable lines name no registry package and are skipped.
 */
function requirements(path: string, dev: boolean, specs: Spec[], pins: Map<string, string>, seen: Set<string>, warnings: string[], asConstraints = false, from?: string) {
  const real = resolve(path);
  if (seen.has(real)) return;
  seen.add(real);
  const text = read(real);
  if (text === null) {
    if (from) warnings.push(`${from} includes ${path}, which could not be read.`);
    return;
  }
  for (const logical of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const l = logical.replace(/(^|\s)#.*$/, '').trim();
    if (!l) continue;
    const inc = /^(-r|--requirement|-c|--constraint)(?:\s*=\s*|\s+)(\S+)/.exec(l);
    if (inc) {
      requirements(join(dirname(real), inc[2]!), dev, specs, pins, seen, warnings, asConstraints || /^(-c|--constraint)$/.test(inc[1]!), path);
      continue;
    }
    if (l.startsWith('-')) continue; // -e, --index-url, …
    const spec = l.split(/\s+--?(?=[A-Za-z])/)[0]!.trim();
    if (/^[A-Za-z][\w+.-]*:\/\//.test(spec) || /^[.~/\\]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec)) continue;
    if (asConstraints) {
      const pin = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;,]+)\s*(;.*)?$/.exec(spec);
      if (pin) pins.set(normalizeName('pypi', pin[1]!), pin[2]!);
      continue;
    }
    specs.push({ spec, dev });
  }
}

const REQUIREMENTS = /^(requirements|dev-requirements|test-requirements)[\w.-]*\.txt$/;
const isDevFile = (f: string) => /dev|test|lint|doc|typ/i.test(f);

/**
 * Declared Python dependencies from, in order: pyproject.toml (PEP 621 dependencies and every
 * optional-dependencies group, PEP 735 groups, `[tool.uv] dev-dependencies`, Poetry), Pipfile, setup.cfg and
 * requirements files (`requirements*.txt` and `requirements/*.txt`, following `-r`).
 */
export function declaredPypi(dir: string, warnings: string[] = []): Declared[] {
  const specs: Spec[] = [];
  const skip = new Set<string>();
  const reqFiles: { file: string; dev: boolean }[] = [];
  const py = read(join(dir, 'pyproject.toml'));
  if (py) pyproject(py, specs, skip, reqFiles, warnings);
  const pf = read(join(dir, 'Pipfile'));
  if (pf) pipfile(pf, specs);
  const cfg = read(join(dir, 'setup.cfg'));
  if (cfg) setupCfg(cfg, specs);
  if (existsSync(join(dir, 'setup.py')) && !py && !cfg) warnings.push('setup.py is code and is not read; declare dependencies in pyproject.toml, or keep a requirements file next to it.');
  const listing = (d: string) => { try { return readdirSync(d).sort(); } catch { return []; } };
  // requirements.txt first, so a dev file that `-r` includes it can't mark runtime dependencies as dev.
  for (const f of listing(dir).sort((a, b) => Number(b === 'requirements.txt') - Number(a === 'requirements.txt'))) {
    if (REQUIREMENTS.test(f)) reqFiles.push({ file: f, dev: f !== 'requirements.txt' && isDevFile(f) });
  }
  for (const f of listing(join(dir, 'requirements'))) if (/\.txt$/.test(f)) reqFiles.push({ file: `requirements/${f}`, dev: isDevFile(f) });
  const pins = new Map<string, string>();
  const seenFiles = new Set<string>();
  for (const { file, dev } of reqFiles) requirements(join(dir, file), dev, specs, pins, seenFiles, warnings);

  const locked = lockedPypi(dir);
  const seen = new Set<string>();
  const out: Declared[] = [];
  for (const { spec, dev, note } of specs) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\[[^\]]*\])?\s*([^;]*)/.exec(spec.trim());
    if (!m || spec.includes('@')) continue; // `name @ https://…`: a direct reference, not a registry release
    const name = normalizeName('pypi', m[1]!);
    if (skip.has(name) || seen.has(name)) continue;
    seen.add(name);
    const range = m[2]!.trim().replace(/^\((.*)\)$/, '$1').trim();
    out.push({ name: clean(name), range: clean(range), version: locked.get(name) ?? pins.get(name) ?? null, dev, ...(note ? { note } : {}) });
  }
  return out;
}

function lockedPypi(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of ['uv.lock', 'poetry.lock']) {
    const t = read(join(dir, f));
    if (!t) continue;
    for (const m of t.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) out.set(normalizeName('pypi', m[1]!), m[2]!);
  }
  return out;
}

// ---------------------------------------------------------------- command

/**
 * The spec we check: the exact locked version when known; otherwise the declared range itself, which is what a
 * fresh install would resolve (checking the range's floor would test a version nobody actually gets).
 */
export function specFor(eco: Ecosystem, d: Declared): string {
  if (d.version) return eco === 'npm' ? `${d.name}@${d.version}` : `${d.name}==${d.version}`;
  if (!d.range || d.range === '*' || d.range === 'latest') return d.name;
  return eco === 'npm' ? `${d.name}@${d.range}` : `${d.name}${d.range}`;
}

/** Does `dir` itself hold a manifest for this ecosystem? */
export function hasManifest(dir: string, eco: Ecosystem): boolean {
  if (eco === 'npm') return existsSync(join(dir, 'package.json'));
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return false; }
  return names.some((n) => n === 'pyproject.toml' || n === 'Pipfile' || n === 'setup.cfg' || n === 'setup.py' || REQUIREMENTS.test(n)) || existsSync(join(dir, 'requirements'));
}

type Bucket = 'block' | 'unchecked' | 'unverified' | 'warn' | 'info' | 'ok';
/** Every result lands in exactly one bucket; nothing that wasn't fully checked counts as ok. */
const bucket = (r: CheckResult): Bucket =>
  r.severity === 'block' ? 'block' : r.verdict === 'error' ? 'unchecked' : r.unverified ? 'unverified' : r.verdict === 'ok' ? 'ok' : r.severity === 'warn' ? 'warn' : 'info';
/**
 * Rows `scan` lists only with --all: ok ones, and info-level "replace" advice (e18e module-replacements). In an
 * existing project that advice is mostly noise (dev tooling, a framework's own deps); `check` still shows it,
 * because there the agent is choosing a new dependency.
 */
const quiet = (r: CheckResult) => bucket(r) === 'ok' || (bucket(r) === 'info' && r.verdict === 'replace');
const ORDER: Bucket[] = ['block', 'unchecked', 'unverified', 'warn', 'info', 'ok'];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function cmdScan(args: Args, meta: Meta): Promise<number> {
  const dir = meta.cwd;
  const forced = !!(args.flags.npm || args.flags.pypi);
  const ecos = forced ? [meta.eco] : [meta.eco, ...(['npm', 'pypi'] as const).filter((e) => e !== meta.eco && hasManifest(dir, e))];
  const warnings: string[] = [];
  const sections: { meta: Meta; declared: Declared[]; results: CheckResult[] }[] = [];
  for (const eco of ecos) {
    const m = eco === meta.eco ? meta : contextFor(args, dir, eco);
    const declared = eco === 'npm' ? declaredNpm(dir, warnings) : declaredPypi(dir, warnings);
    if (!declared.length) continue;
    const results = await checkMany(declared.map((d) => specFor(eco, d)), { ecosystem: eco, cooldownDays: m.cooldown.days, cooldownSource: m.cooldown.source, fast: true, exemptFresh: exemptFor(m) });
    results.forEach((r, i) => { const note = declared[i]!.note; if (note) r.notes.unshift(note); });
    sections.push({ meta: m, declared, results });
  }
  if (!sections.length) {
    const what = forced ? (meta.eco === 'npm' ? 'package.json' : 'Python') : 'package.json or Python';
    return fail(args, [`No ${what} dependencies found in ${dir}.`, ...warnings].join('\n'));
  }
  const all = sections.flatMap((s) => s.results);
  const code = exitFor(all);

  if (args.flags.json) {
    const primary = sections[0]!;
    const json = toJSON(all, primary.meta);
    const declared = sections.flatMap((s) => s.declared.map((d) => ({ ...d, ecosystem: s.meta.eco })));
    const ecosystems = sections.map((s) => ({ ecosystem: s.meta.eco, packageManager: s.meta.pm, cooldown: { days: s.meta.cooldown.days, source: s.meta.cooldown.source } }));
    process.stdout.write(JSON.stringify({ ...json, install: undefined, ecosystems, warnings, declared }, null, 2) + '\n');
    return code;
  }

  const full = !!(args.flags.all || args.flags.verbose);
  for (const w of warnings) process.stdout.write(`\n  ${c.yellow('!')} ${w}`);
  for (const { meta: m, declared, results } of sections) {
    const rows = results.map((r, i) => ({ r, d: declared[i]! })).sort((a, b) => ORDER.indexOf(bucket(a.r)) - ORDER.indexOf(bucket(b.r)));
    const shown = full ? rows : rows.filter((x) => !quiet(x.r));
    process.stdout.write(renderHeader(m.eco, m.cooldown.days, m.cooldown.source) + '\n');
    if (shown.length) {
      const labels = new Map(shown.map(({ r, d }) => [r, `${d.where ? c.gray(`${d.where} › `) : ''}${d.name} ${c.gray(d.version ?? d.range)}`]));
      process.stdout.write(renderResults(shown.map((x) => x.r), { pm: m.pm, verbose: !!args.flags.verbose, label: (r) => labels.get(r) ?? r.name }));
    }
  }
  const count = (b: Bucket) => all.filter((r) => bucket(r) === b).length;
  const summary = [
    count('block') && c.red(`${count('block')} blocking`),
    count('unchecked') && c.yellow(`${count('unchecked')} could not check`),
    count('unverified') && c.yellow(`${count('unverified')} unverified`),
    count('warn') && c.yellow(`${count('warn')} to review`),
    count('info') && c.cyan(`${plural(count('info'), 'suggestion', 'suggestions')}${!full && all.some((r) => bucket(r) === 'info' && quiet(r)) ? ' (--all to show)' : ''}`),
    c.green(`${count('ok')} ok`),
  ].filter(Boolean).join(c.gray(' · '));
  const hidden = !full && count('ok') > 0;
  process.stdout.write(`\n  ${c.bold(plural(all.length, 'dependency', 'dependencies'))}  ${summary}${hidden ? c.gray('  (--all to list ok)') : ''}\n`);
  if (count('unchecked') || count('unverified')) {
    process.stdout.write(`  ${c.yellow('Not a clean bill of health:')} ${c.gray("a registry or advisory lookup failed. Re-run, or run your package manager's audit.")}\n`);
  }
  process.stdout.write('\n');
  return code;
}
