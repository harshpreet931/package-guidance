// Minimal version handling for scoring. Deliberately self-contained (no `semver` dependency)
// and deliberately NOT shared with package-guidance's CLI, so the scorer is independent.

// ---------------- npm semver (subset) ----------------
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v) {
  const m = SEMVER.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [], raw: v };
}
export const isPrerelease = (v) => { const p = parseSemver(v); return !p || p.pre.length > 0; };

export function cmpSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a;
  const y = typeof b === 'string' ? parseSemver(b) : b;
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// partial version "1", "1.2", "1.2.x", "*", "" -> {parts:[...numbers], wild:boolean}
function partial(s) {
  s = s.replace(/^[=v]+/, '');
  if (s === '' || s === '*' || s === 'x' || s === 'X') return { parts: [], pre: '' };
  const [core, ...preRest] = s.split('-');
  const pre = preRest.join('-');
  const parts = [];
  for (const p of core.split('.')) {
    if (p === 'x' || p === 'X' || p === '*') break;
    if (!/^\d+$/.test(p)) return null;
    parts.push(+p);
  }
  return { parts, pre };
}
const ver = (ma, mi = 0, pa = 0, pre = '') => `${ma}.${mi}.${pa}${pre ? '-' + pre : ''}`;

/** Desugar one comparator token into [[op, version], ...]. Returns null if unparseable. */
function desugar(tok) {
  const m = /^(\^|~>?|>=|<=|>|<|=)?\s*(.*)$/.exec(tok);
  const op = m[1] || '';
  const p = partial(m[2]);
  if (!p) return null;
  const [ma, mi, pa] = p.parts;
  const n = p.parts.length;
  if (op === '^') {
    if (n === 0) return [];
    const lo = ver(ma, mi ?? 0, pa ?? 0, p.pre);
    if (ma > 0 || n === 1) return [['>=', lo], ['<', ver(ma + 1, 0, 0, '0')]];
    if (mi > 0 || n === 2) return [['>=', lo], ['<', ver(0, mi + 1, 0, '0')]];
    return [['>=', lo], ['<', ver(0, 0, pa + 1, '0')]];
  }
  if (op === '~' || op === '~>') {
    if (n === 0) return [];
    const lo = ver(ma, mi ?? 0, pa ?? 0, p.pre);
    if (n === 1) return [['>=', lo], ['<', ver(ma + 1, 0, 0, '0')]];
    return [['>=', lo], ['<', ver(ma, mi + 1, 0, '0')]];
  }
  if (op === '' || op === '=') {
    if (n === 3) return [['=', ver(ma, mi, pa, p.pre)]];
    if (n === 0) return [];
    if (n === 1) return [['>=', ver(ma, 0, 0)], ['<', ver(ma + 1, 0, 0, '0')]];
    return [['>=', ver(ma, mi, 0)], ['<', ver(ma, mi + 1, 0, '0')]];
  }
  if (n === 0) return op === '<' ? [['<', '0.0.0-0']] : [];
  if (n === 3) return [[op, ver(ma, mi, pa, p.pre)]];
  // partial with operator
  const bump = n === 1 ? ver(ma + 1, 0, 0) : ver(ma, mi + 1, 0);
  const floor = n === 1 ? ver(ma, 0, 0) : ver(ma, mi, 0);
  if (op === '>') return [['>=', bump]];
  if (op === '>=') return [['>=', floor]];
  if (op === '<') return [['<', floor]];
  if (op === '<=') return [['<', bump]];
  return null;
}

/** Parse an npm range into array of comparator sets, or null if not a semver range. */
export function parseRange(range) {
  range = String(range).trim();
  if (range === '' || range === 'latest' || range === '*') return [[]];
  const sets = [];
  for (let part of range.split('||')) {
    part = part.trim();
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(part);
    if (hy) {
      const lo = desugar('>=' + hy[1]);
      const hp = partial(hy[2]);
      if (!lo || !hp) return null;
      const hi = hp.parts.length === 3 ? [['<=', ver(...hp.parts)]] : desugar('<=' + hy[2]);
      sets.push([...lo, ...hi]);
      continue;
    }
    const toks = part.replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    const set = [];
    for (const t of toks) { const d = desugar(t); if (!d) return null; set.push(...d); }
    sets.push(set);
  }
  return sets;
}

function testCmp([op, v], x) {
  const c = cmpSemver(x, v);
  switch (op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
  }
  return false;
}

export function satisfies(version, range, { includePrerelease = false } = {}) {
  const p = parseSemver(version);
  if (!p) return false;
  const sets = typeof range === 'string' ? parseRange(range) : range;
  if (!sets) return false;
  return sets.some((set) => {
    if (!set.every((c) => testCmp(c, p))) return false;
    if (p.pre.length && !includePrerelease) {
      // prerelease only allowed if some comparator in the set targets the same tuple with a prerelease
      return set.some(([, v]) => { const q = parseSemver(v); return q && q.pre.length && q.pre[0] !== '0' && q.major === p.major && q.minor === p.minor && q.patch === p.patch; });
    }
    return true;
  });
}

// ---------------- PEP 440 (subset) ----------------
const PEP440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)((?:a|b|c|rc|alpha|beta|pre|preview)\.?\d*)?(?:[-_.]?(?:post|rev|r)\.?(\d*)|-(\d+))?(?:[-_.]?dev\.?(\d*))?(?:\+[a-z0-9.]+)?$/i;

export function parsePep440(v) {
  const m = PEP440.exec(String(v).trim());
  if (!m) return null;
  return {
    epoch: +(m[1] || 0),
    release: m[2].split('.').map(Number),
    pre: m[3] || null,
    post: m[4] !== undefined ? +(m[4] || 0) : m[5] !== undefined ? +m[5] : null,
    dev: m[6] !== undefined ? +(m[6] || 0) : null,
    raw: v,
  };
}
export const isPyPrerelease = (v) => { const p = parsePep440(v); return !p || !!p.pre || p.dev !== null; };

function cmpRelease(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}
export function cmpPep440(a, b) {
  const x = typeof a === 'string' ? parsePep440(a) : a;
  const y = typeof b === 'string' ? parsePep440(b) : b;
  if (!x || !y) return 0;
  if (x.epoch !== y.epoch) return x.epoch - y.epoch;
  const r = cmpRelease(x.release, y.release);
  if (r) return r;
  // dev < pre < final < post (approximate ordering)
  const rank = (p) => (p.pre === null && p.dev !== null && p.post === null ? 0 : p.pre ? 1 : 2);
  const rx = rank(x), ry = rank(y);
  if (rx !== ry) return rx - ry;
  if (x.pre && y.pre && x.pre !== y.pre) return x.pre < y.pre ? -1 : 1;
  return (x.post ?? -1) - (y.post ?? -1) || (y.dev === null ? 0 : x.dev === null ? 1 : x.dev - y.dev);
}

/** Parse a PEP 440 specifier set ("">=1.2,<2", "==1.4.*", "~=2.1") or poetry ("^1.2", "~1.2"). */
export function parsePySpec(spec) {
  spec = String(spec || '').trim();
  if (spec === '' || spec === '*') return [];
  const out = [];
  for (let c of spec.split(',')) {
    c = c.trim();
    if (!c) continue;
    const m = /^(===|==|!=|~=|>=|<=|>|<|\^|~|=)?\s*(.+)$/.exec(c);
    if (!m) return null;
    const op = m[1] || '==';
    const v = m[2].trim();
    if (op === '^' || (op === '~' && !v.endsWith('*'))) {
      const p = parsePep440(v);
      if (!p) return null;
      const r = p.release;
      let upper;
      if (op === '^') {
        const i = r.findIndex((x) => x !== 0);
        const idx = i === -1 ? r.length - 1 : i;
        upper = r.slice(0, idx + 1); upper[idx]++;
      } else {
        upper = r.length === 1 ? [r[0] + 1] : [r[0], r[1] + 1];
      }
      out.push(['>=', v], ['<', upper.join('.') + '.dev0']);
      continue;
    }
    if (op === '~=') {
      const p = parsePep440(v);
      if (!p || p.release.length < 2) return null;
      const up = p.release.slice(0, -1); up[up.length - 1]++;
      out.push(['>=', v], ['<', up.join('.') + '.dev0']);
      continue;
    }
    if ((op === '==' || op === '!=' || op === '=') && v.endsWith('.*')) { out.push([op === '!=' ? '!=*' : '==*', v.slice(0, -2)]); continue; }
    out.push([op === '=' ? '==' : op, v]);
  }
  return out;
}

export function pySatisfies(version, spec, { includePrerelease = false } = {}) {
  const p = parsePep440(version);
  if (!p) return false;
  const cs = Array.isArray(spec) ? spec : parsePySpec(spec);
  if (!cs) return false;
  if (!includePrerelease && (p.pre || p.dev !== null) && !cs.some(([, v]) => isPyPrerelease(v))) return false;
  return cs.every(([op, v]) => {
    if (op === '==*' || op === '!=*') {
      const pre = v.split('.').map(Number);
      const match = pre.every((x, i) => (p.release[i] ?? 0) === x);
      return op === '==*' ? match : !match;
    }
    const c = cmpPep440(p, v);
    switch (op) {
      case '==': case '===': return c === 0;
      case '!=': return c !== 0;
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
    }
    return false;
  });
}

// ---------------- ecosystem-generic facade ----------------
export const eco = {
  npm: {
    cmp: cmpSemver,
    isPre: isPrerelease,
    satisfies: (v, r) => satisfies(v, r),
    major: (v) => parseSemver(v)?.major ?? null,
    exact: (spec) => !!parseSemver(String(spec).replace(/^=/, '')),
    valid: (spec) => parseRange(spec) !== null,
  },
  pypi: {
    cmp: cmpPep440,
    isPre: isPyPrerelease,
    satisfies: (v, r) => pySatisfies(v, r),
    major: (v) => parsePep440(v)?.release[0] ?? null,
    exact: (spec) => /^(===?)\s*[^*,]+$/.test(String(spec).trim()),
    valid: (spec) => parsePySpec(spec) !== null,
  },
};

/** Lowest / highest published version satisfying `range`, optionally only versions published <= atMs. */
export function pickVersion(ecosystem, versions, times, range, { highest = false, atMs = Infinity } = {}) {
  const E = eco[ecosystem];
  const cands = versions.filter((v) => !E.isPre(v) && (times[v] === undefined || times[v] <= atMs) && E.satisfies(v, range));
  if (!cands.length) return null;
  cands.sort(E.cmp);
  return highest ? cands[cands.length - 1] : cands[0];
}
