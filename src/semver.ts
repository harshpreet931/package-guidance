/**
 * Version ordering and range matching for the two grammars this tool speaks:
 *   - `npm`:    node-semver (https://github.com/npm/node-semver#ranges)
 *   - `pep440`: Python packaging (https://packaging.python.org/en/latest/specifications/version-specifiers/)
 * The grammars differ in ways that matter here: `==2.0` is exact in PEP 440 but `2.0` is a prefix in npm;
 * `.dev` sorts before pre-releases in PEP 440; npm has no epochs or post-releases.
 */

export type Flavor = 'npm' | 'pep440';

export interface Version {
  raw: string;
  flavor: Flavor;
  epoch: number;
  release: number[];
  /** npm: prerelease identifiers (`beta.2` → ['beta', 2]). pep440: [phase, n] with phase a | b | rc. */
  pre: (string | number)[];
  post: number | null; // pep440 only
  dev: number | null; // pep440 only
}

// ------------------------------------------------------------------ parsing

const NPM_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PEP440_VERSION =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(?:post|rev|r)[-_.]?(\d*)))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;
const PHASE: Record<string, string> = { a: 'a', alpha: 'a', b: 'b', beta: 'b', c: 'rc', rc: 'rc', pre: 'rc', preview: 'rc' };

export function parse(input: string, flavor: Flavor = 'npm'): Version | null {
  const s = input.trim();
  if (flavor === 'npm') {
    const m = NPM_VERSION.exec(s);
    if (!m) return null;
    return {
      raw: input, flavor, epoch: 0,
      release: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
      post: null, dev: null,
    };
  }
  const m = PEP440_VERSION.exec(s);
  if (!m) return null;
  const post = m[5] ?? m[6];
  return {
    raw: input, flavor,
    epoch: m[1] ? Number(m[1]) : 0,
    release: m[2]!.split('.').map(Number),
    pre: m[3] ? [PHASE[m[3].toLowerCase()]!, m[4] ? Number(m[4]) : 0] : [],
    post: post !== undefined ? Number(post || 0) : null,
    dev: m[7] !== undefined ? Number(m[7] || 0) : null,
  };
}

export const isStable = (v: Version) => v.pre.length === 0 && v.dev === null;
export const major = (v: Version) => v.release[0] ?? 0;

// ------------------------------------------------------------------ ordering

function compareRelease(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function compareNpmPre(a: (string | number)[], b: (string | number)[]): number {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0; // a release sorts after its prereleases
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return Math.sign(x - y);
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const PHASE_RANK: Record<string, number> = { a: 0, b: 1, rc: 2 };

/** PEP 440 sort key for everything after the release segment (see packaging.version._cmpkey). */
function pepTail(v: Version): number[] {
  const NEG = -Infinity;
  const POS = Infinity;
  // A dev release of a final version sorts before its pre-releases: 1.0.dev1 < 1.0a1 < 1.0.
  const pre = v.pre.length ? [PHASE_RANK[v.pre[0] as string]!, v.pre[1] as number] : v.post === null && v.dev !== null ? [NEG, 0] : [POS, 0];
  const post = v.post === null ? NEG : v.post;
  const dev = v.dev === null ? POS : v.dev;
  return [...pre, post, dev];
}

export function compare(a: Version, b: Version): number {
  if (a.epoch !== b.epoch) return Math.sign(a.epoch - b.epoch);
  const r = compareRelease(a.release, b.release);
  if (r) return r;
  if (a.flavor === 'npm' && b.flavor === 'npm') return compareNpmPre(a.pre, b.pre);
  const x = pepTail(a);
  const y = pepTail(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

// ------------------------------------------------------------------ ranges

type Test = (v: Version) => boolean;
interface Comparator { test: Test; /** the version this comparator names, if it names a prerelease */ pre?: Version }
export interface Range { flavor: Flavor; sets: Comparator[][] }

const zeros = (n: number[], len: number) => [...n, ...Array<number>(Math.max(0, len - n.length)).fill(0)];
const at = (release: number[], flavor: Flavor): Version => ({ raw: release.join('.'), flavor, epoch: 0, release: zeros(release, 3), pre: [], post: null, dev: null });
const bump = (parts: number[]) => [...parts.slice(0, -1), parts[parts.length - 1]! + 1];
const cmp = (op: string, bound: Version): Test => (v) => {
  const d = compare(v, bound);
  return op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : op === '>=' ? d >= 0 : op === '!=' ? d !== 0 : d === 0;
};
/** For npm prerelease bounds: `<2.0.0` must not admit `2.0.0-rc.1`, so compare "lower than the first prerelease". */
const npmLowestOf = (release: number[]): Version => ({ ...at(release, 'npm'), pre: [0] });

// npm ---------------------------------------------------------------

/** `1`, `1.2`, `1.x`, `1.2.*`, `1.2.3`, `1.2.3-beta.1` → numeric parts given (wildcards dropped) + full version if complete. */
function npmPartial(s: string): { parts: number[]; full: Version | null } | null {
  const clean = s.replace(/^[=v]+/, '');
  if (/^[x*]?$/i.test(clean)) return { parts: [], full: null };
  const full = parse(clean, 'npm');
  if (full) return { parts: full.release, full };
  const m = /^(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?$/i.exec(clean);
  if (!m) return null;
  const parts: number[] = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /^[x*]$/i.test(p)) break;
    parts.push(Number(p));
  }
  return { parts, full: null };
}

function npmComparator(token: string): Comparator[] | null {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = npmPartial(m[2]!);
  if (!p) return null;
  const { parts, full } = p;
  const lower = full ?? at(parts, 'npm');
  const pre = full?.pre.length ? full : undefined;
  if (!parts.length) return op === '<' || op === '>' ? [{ test: () => false }] : []; // `*` / `>=*`
  switch (op) {
    case '^': {
      // Bump the first non-zero part; if all given parts are zero, bump the last one given.
      // ^1.2.3 → <2.0.0 · ^0.2.3 → <0.3.0 · ^0.0.3 → <0.0.4 · ^0.0 → <0.1.0 · ^0 → <1.0.0
      const firstNonZero = parts.findIndex((n) => n !== 0);
      const upper = bump(parts.slice(0, firstNonZero === -1 ? parts.length : firstNonZero + 1));
      return [{ test: cmp('>=', lower), pre }, { test: cmp('<', npmLowestOf(upper)) }];
    }
    case '~': case '~>':
      return [{ test: cmp('>=', lower), pre }, { test: cmp('<', npmLowestOf(bump(parts.slice(0, parts.length === 1 ? 1 : 2)))) }];
    case '>=': return [{ test: cmp('>=', lower), pre }];
    case '<': return [{ test: cmp('<', full ?? npmLowestOf(parts)), pre }];
    case '>': return [{ test: full ? cmp('>', full) : cmp('>=', npmLowestOf(bump(parts))), pre }];
    case '<=': return [{ test: full ? cmp('<=', full) : cmp('<', npmLowestOf(bump(parts))), pre }];
    default:
      if (full) return [{ test: cmp('=', full), pre }];
      return [{ test: cmp('>=', lower) }, { test: cmp('<', npmLowestOf(bump(parts))) }];
  }
}

function parseNpmRange(input: string): Range | null {
  const sets: Comparator[][] = [];
  for (const alt of input.split('||')) {
    let s = alt.trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    const tokens: string[] = [];
    if (hyphen) {
      tokens.push(`>=${hyphen[1]}`);
      const hi = npmPartial(hyphen[2]!);
      if (!hi) return null;
      tokens.push(hi.full ? `<=${hyphen[2]}` : `<${bump(hi.parts).join('.')}`);
    } else {
      s = s.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1');
      tokens.push(...s.split(/\s+/).filter(Boolean));
    }
    const set: Comparator[] = [];
    for (const t of tokens) {
      const c = npmComparator(t);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return { flavor: 'npm', sets };
}

// PEP 440 -------------------------------------------------------------

function pepComparator(token: string): Comparator[] | null {
  const m = /^(~=|===|==|!=|<=|>=|<|>)\s*(.+)$/.exec(token.trim());
  if (!m) return null;
  const [, op, raw] = m as unknown as [string, string, string];
  if (op === '===') return [{ test: (v) => v.raw.trim() === raw.trim() }];
  const wildcard = /^(.*)\.\*$/.exec(raw);
  if (wildcard && (op === '==' || op === '!=')) {
    const prefix = parse(wildcard[1]!, 'pep440');
    if (!prefix) return null;
    const inPrefix: Test = (v) => v.epoch === prefix.epoch && prefix.release.every((n, i) => (v.release[i] ?? 0) === n);
    return [{ test: op === '==' ? inPrefix : (v) => !inPrefix(v) }];
  }
  const bound = parse(raw, 'pep440');
  if (!bound) return null;
  const pre = isStable(bound) ? undefined : bound;
  switch (op) {
    case '~=': {
      if (bound.release.length < 2) return null;
      const upper = bump(bound.release.slice(0, -1));
      return [{ test: cmp('>=', bound), pre }, { test: (v) => compare(v, { ...at(upper, 'pep440'), release: upper, pre: [], dev: 0 }) < 0 }];
    }
    case '==': return [{ test: cmp('=', bound), pre }];
    case '!=': return [{ test: cmp('!=', bound) }];
    case '<': return [{ test: (v) => compare(v, bound) < 0 && (pre !== undefined || !(isStable(bound) && !isStable(v) && compareRelease(v.release, bound.release) === 0)), pre }];
    case '>': return [{ test: (v) => compare(v, bound) > 0 && !(v.post !== null && bound.post === null && compareRelease(v.release, bound.release) === 0), pre }];
    default: return [{ test: cmp(op, bound), pre }];
  }
}

function parsePepRange(input: string): Range | null {
  const tokens = input.split(',').map((t) => t.trim()).filter(Boolean);
  const set: Comparator[] = [];
  for (const t of tokens) {
    const c = pepComparator(t);
    if (!c) return null;
    set.push(...c);
  }
  return { flavor: 'pep440', sets: [set] };
}

// ------------------------------------------------------------------ public API

export function parseRange(input: string, flavor: Flavor = 'npm'): Range | null {
  const s = input.trim();
  if (s === '' || s === '*' || s === 'latest') return { flavor, sets: [[]] };
  return flavor === 'npm' ? parseNpmRange(s) : parsePepRange(s);
}

/**
 * Prereleases only match when the range opts in: npm requires a comparator naming a prerelease of the same
 * major.minor.patch; PEP 440 admits them when any specifier names a prerelease. `includePrerelease` overrides.
 */
export function satisfies(version: string | Version, range: string | Range, opts: { includePrerelease?: boolean } = {}): boolean {
  const r = typeof range === 'string' ? parseRange(range, typeof version === 'string' ? 'npm' : version.flavor) : range;
  const v = typeof version === 'string' ? parse(version, r?.flavor ?? 'npm') : version;
  if (!v || !r) return false;
  return r.sets.some((set) => {
    if (!set.every((c) => c.test(v))) return false;
    if (isStable(v) || opts.includePrerelease) return true;
    if (v.flavor === 'pep440') return set.some((c) => c.pre);
    return set.some((c) => c.pre && compareRelease(c.pre.release, v.release) === 0);
  });
}

/** Whether a range names a prerelease, i.e. the user is asking for one. */
export function mentionsPrerelease(range: string, flavor: Flavor): boolean {
  return flavor === 'npm' ? /\d-[0-9A-Za-z]/.test(range) : /\d(a|b|rc|c|alpha|beta|pre|preview|\.?dev)\d*/i.test(range);
}
