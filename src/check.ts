/**
 * The decision procedure. For one requested package:
 *
 *   1. resolve   — does it exist? which versions, published when?
 *   2. select    — newest *settled* version (older than the cooldown), within the requested range if any
 *   3. security  — advisories on the selection; move to a fixed version when one exists
 *   4. adoption  — brand-new or near-zero-download packages look like slopsquats
 *   5. install   — lifecycle scripts, yanked releases
 *   6. knowledge — curated entries and e18e replacements ("right package?")
 *
 * Every stage emits findings. The most severe finding becomes the verdict; the rest become notes.
 */
import { NotFound, mapLimit } from './net.ts';
import * as registry from './registry.ts';
import { type Ecosystem, type VersionInfo, normalizeName } from './registry.ts';
import * as osv from './osv.ts';
import { type Advisory, isSerious, sanitize } from './osv.ts';
import { type Entry, entriesFor, e18eFor } from './knowledge.ts';
import { compare, isStable, major, mentionsPrerelease, parse, parseRange, satisfies, type Flavor, type Range, type Version } from './semver.ts';

export type Verdict = 'ok' | 'caution' | 'outdated' | 'replace' | 'deprecated' | 'vulnerable' | 'malicious' | 'not-found' | 'young' | 'unproven' | 'error';
export type Severity = 'ok' | 'info' | 'warn' | 'block';

export interface CheckContext {
  ecosystem: Ecosystem;
  cooldownDays: number;
  cooldownSource: string;
  now?: Date;
  /** Skip lookups that only add notes (install scripts, yanked status). The hook uses this to stay fast. */
  fast?: boolean;
  /** Data sources; defaults to the live registries. Tests inject fixtures here. */
  sources?: Partial<Sources>;
  /**
   * Set when the repo enforces its own release-age cooldown: how to let one fresh security fix through it.
   * Without this, the package manager would refuse the very version we recommend.
   */
  exemptFresh?: (name: string, version: string) => string;
}

export interface Sources {
  getPackage: typeof registry.getPackage;
  advisories: typeof osv.advisories;
  weeklyDownloads: typeof registry.weeklyDownloads;
  npmInstallScripts: typeof registry.npmInstallScripts;
  pypiYanked: typeof registry.pypiYanked;
}

const LIVE: Sources = {
  getPackage: registry.getPackage,
  advisories: osv.advisories,
  weeklyDownloads: registry.weeklyDownloads,
  npmInstallScripts: registry.npmInstallScripts,
  pypiYanked: registry.pypiYanked,
};

export interface CheckResult {
  name: string;
  requested: string;
  range: string | null;
  ecosystem: Ecosystem;
  verdict: Verdict;
  severity: Severity;
  message: string;
  /** Version we recommend installing, pinned. `null` means: do not install this package. */
  version: string | null;
  /** The version that was assessed (what the request resolves to before any upgrade). */
  resolved: string | null;
  publishedAt: string | null;
  ageDays: number | null;
  latest: { version: string; publishedAt: string; ageDays: number } | null;
  /** What the package manager would install for this request right now, ignoring the cooldown. */
  wouldInstall: { version: string; ageDays: number } | null;
  /** When the requested version is vulnerable: the settled version that fixes it (equals `version`). */
  fixedIn: string | null;
  advisories: Advisory[];
  entry: Pick<Entry, 'id' | 'status' | 'summary' | 'replacements' | 'guide' | 'source'> | null;
  alternatives: string[];
  guide: string | null;
  notes: string[];
  installScripts: string[];
  /** True when the advisory lookup failed: nothing here says the version is free of known advisories. */
  unverified: boolean;
}

interface Finding { verdict: Verdict; severity: Severity; message: string; curated?: boolean }

const DAY = 86_400_000;
const SLOPSQUAT_MAX_AGE_DAYS = 30;
const SLOPSQUAT_MAX_WEEKLY = 1000;
const UNPROVEN_MAX_WEEKLY = 250;

const VERDICT_RANK: Record<Verdict, number> = {
  ok: 0, error: 1, caution: 2, outdated: 2, replace: 3, young: 4, unproven: 4, deprecated: 5, vulnerable: 6, malicious: 8, 'not-found': 9,
};
const SEVERITY_RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, block: 3 };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SERIOUS = ['high/critical advisory', 'high/critical advisories'] as const;
export const formatAge = (d: number) => (d < 1 ? '<1d' : `${Math.floor(d)}d`);
/** Registry text is untrusted: no control characters, one line, bounded length. */
const oneLine = (s: string) => sanitize(s).slice(0, 200);

// ---------------------------------------------------------------- spec parsing

/** `react@^18` → { react, ^18 } · `@types/node@20` → { @types/node, 20 } · `pydantic[email]<2; python_version>"3"` → { pydantic, <2 } */
export function parseSpec(eco: Ecosystem, raw: string): { name: string; range: string | null } {
  const s = raw.trim();
  if (eco === 'npm') {
    const at = s.indexOf('@', s.startsWith('@') ? 1 : 0);
    if (at === -1) return { name: s, range: null };
    const range = s.slice(at + 1).trim();
    return { name: s.slice(0, at), range: range && range !== 'latest' ? range : null };
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([^;]*)/.exec(s);
  if (!m) return { name: s, range: null };
  let range = m[2]!.trim().replace(/^\((.*)\)$/, '$1').trim();
  // Agents often borrow npm syntax for Python: `pydantic@1` → `==1.*`, `pydantic@2.5.0` → `==2.5.0`.
  const npmStyle = /^@\s*v?(\d+(?:\.\d+)*)$/.exec(range);
  if (npmStyle) range = npmStyle[1]!.split('.').length < 3 ? `==${npmStyle[1]}.*` : `==${npmStyle[1]}`;
  // Poetry and uvx constraints: `pkg@latest`, `pkg@^1.2` (>=1.2,<2), `pkg@~1.2` (>=1.2,<1.3), `pkg@>=1,<2`.
  else if (range.startsWith('@')) {
    const c = range.slice(1).trim();
    const bump = /^([\^~])(\d+(?:\.\d+)*)$/.exec(c);
    if (bump) {
      const parts = bump[2]!.split('.').map(Number);
      const firstNonZero = parts.findIndex((p) => p !== 0);
      const at = bump[1] === '~' ? Math.min(1, parts.length - 1) : firstNonZero === -1 ? parts.length - 1 : firstNonZero;
      range = `>=${bump[2]},<${[...parts.slice(0, at), parts[at]! + 1].join('.')}`;
    } else range = c === 'latest' || c === '*' ? '' : c;
  }
  return { name: normalizeName('pypi', m[1]!), range: range || null };
}

// ---------------------------------------------------------------- stages

interface Release extends VersionInfo { v: Version; ageDays: number; /** PyPI yank reason; yanked releases are never picked. */ yanked?: string }

const newest = (xs: Release[]) => xs.reduce<Release | null>((best, x) => (!best || compare(x.v, best.v) > 0 ? x : best), null);
const newestFirst = (xs: Release[]) => [...xs].sort((a, b) => compare(b.v, a.v));
/** When nothing has settled: the release that has been public longest on the newest major line, not the newest. */
const mostAged = (xs: Release[]) => {
  const top = newest(xs);
  if (!top) return null;
  return xs.filter((x) => major(x.v) === major(top.v)).reduce((b, x) => (x.ageDays > b.ageDays ? x : b), top);
};

export const flavorOf = (eco: Ecosystem): Flavor => (eco === 'npm' ? 'npm' : 'pep440');

function history(versions: VersionInfo[], flavor: Flavor, now: number): Release[] {
  const out: Release[] = [];
  for (const vi of versions) {
    const v = parse(vi.version, flavor);
    if (v) out.push({ ...vi, v, ageDays: (now - Date.parse(vi.publishedAt)) / DAY });
  }
  return out;
}

interface Selection {
  latest: Release;
  /** What the request resolves to (newest settled match), before any upgrade advice. */
  resolved: Release;
  /** What we recommend. Differs from `resolved` when the request is on an outdated major line. */
  pick: Release;
  /** Newest settled release on the current line, ignoring the requested range. */
  best: Release;
  /** What the package manager would install for the request today (no cooldown). */
  wouldInstall: Release;
  /** Versions the request allows (for looking up security fixes). */
  allowed: Release[];
  /** Stable, non-deprecated releases up to `latest`. */
  line: Release[];
  findings: Finding[];
  /** "holding at X until Y settles", only true while security does not move the pick. */
  holdNote: string | null;
  range: string | null;
}

/** On failure, `version` is the release the finding is about (for matching curated entries). */
type SelectOutcome = { ok: true; selection: Selection } | { ok: false; finding: Finding; version?: string };

function select(releases: Release[], range: string | null, flavor: Flavor, cooldownDays: number): SelectOutcome {
  const candidates = releases.filter((x) => !x.yanked);
  const latest = candidates.find((x) => x.isDefault) ?? newest(candidates.filter((x) => isStable(x.v)));
  if (!latest) return { ok: false, finding: { verdict: 'error', severity: 'info', message: 'No installable versions found.' } };
  if (latest.deprecated) return { ok: false, finding: { verdict: 'deprecated', severity: 'block', message: oneLine(latest.deprecated) } };

  let r: Range | null = null;
  if (range) {
    r = parseRange(range, flavor);
    if (!r) return { ok: false, finding: { verdict: 'error', severity: 'info', message: `Could not understand the version range "${range}".` } };
  }
  const wantsPrerelease = !!range && mentionsPrerelease(range, flavor);
  const usable = candidates.filter((x) => !x.deprecated && (isStable(x.v) || wantsPrerelease));
  const line = usable.filter((x) => compare(x.v, latest.v) <= 0);
  const isSettled = (x: Release) => x.ageDays >= cooldownDays;
  const best = newest(line.filter(isSettled)) ?? mostAged(line);
  if (!best) return { ok: false, finding: { verdict: 'error', severity: 'info', message: 'No stable versions found.' } };

  const findings: Finding[] = [];
  let allowed = line;
  let wouldInstall = latest;
  let resolved = best;

  if (r) {
    const matching = usable.filter((x) => satisfies(x.v, r, { includePrerelease: wantsPrerelease }));
    if (!matching.length) {
      const deprecatedMatch = newest(releases.filter((x) => x.deprecated && satisfies(x.v, r, { includePrerelease: true })));
      return {
        ok: false,
        version: deprecatedMatch?.version,
        finding: deprecatedMatch
          ? { verdict: 'deprecated', severity: 'warn', message: `${deprecatedMatch.version} is deprecated: ${oneLine(deprecatedMatch.deprecated!)}` }
          : { verdict: 'not-found', severity: 'block', message: `Likely hallucinated version: nothing published matches "${range}" (latest is ${latest.version}).` },
      };
    }
    // Releases above the `latest` tag are ones the maintainers chose not to promote (often a bad release they
    // rolled back from). Stay at or below it unless the request only matches versions above it.
    const capped = matching.filter((x) => compare(x.v, latest.v) <= 0);
    allowed = capped.length ? capped : matching;
    // Package managers prefer the `latest` tag when it satisfies the range, else the highest match.
    wouldInstall = satisfies(latest.v, r, { includePrerelease: wantsPrerelease }) ? latest : newest(matching)!;
    resolved = newest(allowed.filter(isSettled)) ?? mostAged(allowed)!;
  }

  let pick = resolved;
  if (major(resolved.v) < major(best.v)) {
    const asked = range === resolved.version ? `you pinned ${range}` : `${range} resolves to ${resolved.version}`;
    findings.push({ verdict: 'outdated', severity: 'warn', message: `v${major(best.v)} is current (${best.version}); ${asked}.` });
    pick = best;
  }

  if (!isSettled(pick)) {
    // Nothing the request allows has settled (e.g. an exact pin to a release from this morning).
    // Fall back to the newest settled release on the same major line, if there is one.
    const fallback = newest(line.filter((x) => isSettled(x) && major(x.v) === major(pick.v) && compare(x.v, pick.v) < 0));
    const nothingSettled = !line.some(isSettled);
    findings.push({
      verdict: 'young', severity: 'warn',
      message: fallback
        ? `Use ${fallback.version}: ${pick.version} is only ${formatAge(pick.ageDays)} old (cooldown ${cooldownDays}d).`
        : nothingSettled
          ? `Wait, or review before pinning: no release has settled yet; ${pick.version} has been public longest, ${formatAge(pick.ageDays)} (cooldown ${cooldownDays}d).`
          : `Wait, or review before pinning: ${pick.version} is only ${formatAge(pick.ageDays)} old and no older release matches (cooldown ${cooldownDays}d).`,
    });
    if (fallback) pick = fallback;
  }

  const holdNote = compare(wouldInstall.v, pick.v) > 0 && !isSettled(wouldInstall)
    ? `${wouldInstall.version} was published ${formatAge(wouldInstall.ageDays)} ago; holding at ${pick.version} until it settles (${cooldownDays}d cooldown).`
    : null;

  return { ok: true, selection: { latest, resolved, pick, best, wouldInstall, allowed, line, findings, holdNote, range } };
}

interface Security { pick: Release; advisories: Advisory[]; fixedIn: string | null; doNotInstall: boolean; findings: Finding[]; notes: string[]; unverified?: boolean }

/**
 * Advisories are assessed on what was *requested* (`resolved`), because that is what the agent was about to
 * install. If it is unsafe we look for the closest safe version, in order of least surprise:
 *   1. our recommendation, when it differs from the request (an upgrade or a settled fallback),
 *   2. a newer version the request allows: settled first, then the *first* patched fresh release,
 *   3. a newer settled version on the same major line, then the newest settled version overall,
 *   4. a fresh fix outside the request (e.g. only in a new major), flagged for review,
 *   5. an older settled release the advisory doesn't affect (a downgrade).
 * A lookup that fails is never read as "no advisories".
 */
async function assessSecurity(
  src: Sources, eco: Ecosystem, name: string, s: Selection, cooldownDays: number,
  exempt: CheckContext['exemptFresh'], yanked: (r: Release) => Promise<string | null>,
): Promise<Security> {
  const memo = new Map<string, Promise<Advisory[]>>();
  const query = (r: Release) => {
    let p = memo.get(r.version);
    if (!p) memo.set(r.version, (p = src.advisories(eco, name, r.version)));
    return p;
  };
  const isSettled = (x: Release) => x.ageDays >= cooldownDays;
  /** Safe = no high/critical or malicious advisory, not yanked, and the lookup actually succeeded. */
  const safe = async (r: Release) => {
    try {
      return !(await query(r)).some(isSerious) && !(await yanked(r));
    } catch {
      return false;
    }
  };
  const out: Security = { pick: s.pick, advisories: [], fixedIn: null, doNotInstall: false, findings: [], notes: [] };
  const unverified = (v: string): Finding => ({
    verdict: 'caution', severity: 'warn',
    message: `Unverified: the advisory lookup (OSV) failed for ${v}. Run your package manager's audit after installing.`,
  });
  const describe = (advs: Advisory[], version: string) => {
    const rated = advs.filter((a) => a.severity !== 'unknown');
    const unrated = advs.filter((a) => a.severity === 'unknown');
    if (rated.length) out.notes.push(`${plural(rated.length, 'low/moderate advisory', 'low/moderate advisories')} on ${version}: ${rated.map((a) => a.id).join(', ')}.`);
    if (unrated.length) {
      out.findings.push({
        verdict: 'caution', severity: 'warn',
        message: `Review: ${plural(unrated.length, 'advisory', 'advisories')} without a severity rating on ${version} (${unrated.map((a) => a.id).join(', ')}).`,
      });
    }
  };

  let requested: Advisory[];
  try {
    requested = await query(s.resolved);
  } catch {
    out.findings.push(unverified(s.pick.version));
    return { ...out, unverified: true };
  }
  out.advisories = requested;

  /** The newest settled release older than `below` that is safe: same major line first. */
  const older = async (below: Release) => {
    const prior = newestFirst(s.line.filter((x) => isSettled(x) && compare(x.v, below.v) < 0));
    const ordered = [...prior.filter((x) => major(x.v) === major(below.v)), ...prior.filter((x) => major(x.v) !== major(below.v))];
    for (const cand of ordered.slice(0, 6)) if (await safe(cand)) return cand;
    return null;
  };

  const malicious = requested.find((a) => a.malicious);
  if (malicious) {
    const alt = await older(s.resolved);
    if (alt) {
      out.findings.push({ verdict: 'malicious', severity: 'block', message: `Use ${alt.version}: ${s.resolved.version} is reported as malicious (${malicious.id}).` });
      return { ...out, pick: alt, fixedIn: alt.version, advisories: await query(alt) };
    }
    out.doNotInstall = true;
    out.findings.push({ verdict: 'malicious', severity: 'block', message: `Do not install: ${s.resolved.version} is reported as malicious (${malicious.id}).` });
    return out;
  }

  const serious = requested.filter(isSerious);
  if (!serious.length) {
    if (s.pick === s.resolved) {
      describe(requested, s.pick.version);
      return out;
    }
    // We recommend something other than what was requested (an upgrade or a settled fallback): it must be safe too.
    let pickAdvs: Advisory[];
    try {
      pickAdvs = await query(s.pick);
    } catch {
      out.findings.push(unverified(s.pick.version));
      return { ...out, unverified: true };
    }
    if (!pickAdvs.some(isSerious)) {
      out.advisories = pickAdvs;
      describe(pickAdvs, s.pick.version);
      return out;
    }
    const sameLine = newestFirst(s.line.filter((x) => x !== s.pick && major(x.v) === major(s.pick.v) && isSettled(x))).slice(0, 4);
    for (const alt of sameLine) {
      if (await safe(alt)) {
        out.notes.push(`${s.pick.version} has high/critical advisories; recommending ${alt.version} instead.`);
        out.advisories = await query(alt);
        return { ...out, pick: alt };
      }
    }
    out.notes.push(`The recommended ${s.pick.version} has high/critical advisories, so staying on ${s.resolved.version}.`);
    describe(requested, s.resolved.version);
    return { ...out, pick: s.resolved };
  }

  const what = `${s.resolved.version} has ${plural(serious.length, ...SERIOUS)}`;
  const inRange = (x: Release) => s.allowed.includes(x);
  const fix = async (cand: Release, how: 'fix' | 'downgrade') => {
    const fresh = !isSettled(cand);
    const exactPin = s.range !== null && s.range.replace(/^(===?|v)\s*/, '') === s.resolved.version;
    const where = s.range && !exactPin && !inRange(cand) ? ` (outside ${s.range}${major(cand.v) > major(s.resolved.v) ? ', a new major' : ''})` : '';
    const lead = how === 'downgrade' ? `Use ${cand.version}, an older release the advisories don't affect` : `Use ${cand.version}${where}`;
    const review = fresh ? ` ${cand.version} is a security fix only ${formatAge(cand.ageDays)} old: review it before relying on it.` : '';
    // A fresh fix the request already allows is what the package manager installs anyway: say so, don't block.
    out.findings.push({ verdict: 'vulnerable', severity: fresh && inRange(cand) && how === 'fix' ? 'warn' : 'block', message: `${lead}: ${what}.${review}` });
    if (fresh && exempt) out.notes.push(exempt(name, cand.version));
    return { ...out, pick: cand, fixedIn: cand.version, advisories: await query(cand) };
  };

  const newer = (x: Release) => compare(x.v, s.resolved.v) > 0;
  const allowedNewer = s.allowed.filter(newer);
  const ordered = [
    ...(s.pick !== s.resolved ? [s.pick] : []),
    // Fresh releases oldest first: the first patched release is the smallest change and has been public longest,
    // and something published right after a real fix isn't picked just for being newest.
    ...newestFirst(allowedNewer.filter(isSettled)),
    ...newestFirst(allowedNewer.filter((x) => !isSettled(x))).reverse(),
    ...newestFirst(s.line.filter((x) => newer(x) && isSettled(x) && major(x.v) === major(s.resolved.v))),
    s.best,
    ...newestFirst(s.line.filter((x) => newer(x) && !isSettled(x))).reverse(),
  ];
  const tried = new Set<Release>();
  for (const cand of ordered) {
    if (tried.has(cand) || cand === s.resolved || tried.size >= 12) continue;
    tried.add(cand);
    if (await safe(cand)) return fix(cand, 'fix');
  }
  const down = await older(s.resolved);
  if (down) return fix(down, 'downgrade');

  out.doNotInstall = true;
  out.findings.push({ verdict: 'vulnerable', severity: 'block', message: `Choose an alternative: ${what} and no fixed version.` });
  return out;
}

async function assessAdoption(src: Sources, eco: Ecosystem, name: string, releases: Release[]): Promise<Finding[]> {
  const ageDays = Math.max(...releases.map((x) => x.ageDays));
  const downloads = await src.weeklyDownloads(eco, name);
  if (ageDays < SLOPSQUAT_MAX_AGE_DAYS && (downloads === null || downloads < SLOPSQUAT_MAX_WEEKLY)) {
    const dl = downloads === null ? '' : ` · ${downloads} downloads last week`;
    return [{ verdict: 'young', severity: 'warn', message: `Confirm it is the official package: first published ${formatAge(ageDays)} ago${dl}.` }];
  }
  if (downloads !== null && downloads < UNPROVEN_MAX_WEEKLY) {
    return [{ verdict: 'unproven', severity: 'warn', message: `Confirm the exact name in official docs: only ${downloads} downloads last week, which is what slopsquats look like.` }];
  }
  return [];
}

async function assessInstall(src: Sources, eco: Ecosystem, name: string, version: string): Promise<{ scripts: string[]; findings: Finding[]; notes: string[] }> {
  if (eco === 'npm') {
    const scripts = await src.npmInstallScripts(name, version);
    const notes = scripts.length ? [`Runs install scripts (${scripts.join(', ')}). Normal for native/binary packages; otherwise review before installing.`] : [];
    return { scripts, findings: [], notes };
  }
  const yanked = await src.pypiYanked(name, version);
  return { scripts: [], findings: yanked ? [{ verdict: 'deprecated', severity: 'warn', message: `${version} is yanked on PyPI: ${oneLine(yanked)}` }] : [], notes: [] };
}

/** Curated entries first; e18e replacements only when nothing curated applies. */
function assessKnowledge(eco: Ecosystem, name: string, version: string | null) {
  const flavor = flavorOf(eco);
  const v = version === null ? null : parse(version, flavor);
  const entry = entriesFor(eco, name).find((e) => {
    if (!e.versions || e.versions === '*') return true;
    const range = parseRange(e.versions, flavor);
    return v !== null && range !== null && satisfies(v, range);
  });
  if (entry) {
    const alternatives = entry.replacements.map((r) => (r.kind === 'native' ? `${r.name} (native)` : r.name));
    // `caution` is context ("fine, but know this"): a visible verdict when it warns, a quiet note when it informs.
    const verdict: Verdict | null =
      entry.status === 'outdated-major' ? 'outdated'
      : entry.status === 'deprecated' || entry.status === 'sunset' ? 'deprecated'
      : entry.status === 'caution' ? (entry.severity === 'info' ? null : 'caution')
      : 'replace';
    return {
      entry,
      alternatives,
      findings: verdict ? [{ verdict, severity: entry.severity, message: entry.summary, curated: true } satisfies Finding] : [],
      notes: verdict ? [] : [entry.summary],
    };
  }
  const e18e = eco === 'npm' ? e18eFor(name) : null;
  if (!e18e) return { entry: null, alternatives: [], findings: [], notes: [] };
  // e18e "removal" replacements are explanations ("use native array methods"), not package names.
  const alternatives = [...new Set(e18e.replacements.filter((r) => r.type !== 'removal').map((r) => (r.type === 'native' ? `${r.id} (native)` : r.id)))].slice(0, 4);
  const explanations = e18e.replacements.filter((r) => r.type === 'removal' && r.description).map((r) => sanitize(r.description!));
  const lead = { native: 'Native alternative available', 'micro-utilities': 'Small enough to inline', preferred: 'Lighter, maintained alternatives' }[e18e.kind];
  const message = explanations[0] && !alternatives.length ? explanations[0] : `${lead}: ${[...alternatives.slice(0, 3), ...(explanations.length ? ['or no dependency at all'] : [])].join(', ')}.`;
  return { entry: null, alternatives, findings: [{ verdict: 'replace', severity: 'info', message } satisfies Finding], notes: explanations.filter((x) => x !== message) };
}

// ---------------------------------------------------------------- compose

/** Most severe first; on ties curated knowledge wins, because it says *why* and *what to do*. */
const byImportance = (a: Finding, b: Finding) =>
  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict] || Number(!!b.curated) - Number(!!a.curated);

/**
 * The most severe finding sets the verdict. The headline message prefers curated knowledge at that same severity,
 * because it says *why* and *what to do*; registry findings it already covers are dropped rather than repeated.
 */
function compose(base: CheckResult, findings: Finding[], notes: string[]): CheckResult {
  const sorted = [...findings].sort(byImportance);
  const top = sorted[0];
  if (!top) return { ...base, verdict: 'ok', severity: 'ok', message: `${base.version} · settled ${formatAge(base.ageDays ?? 0)}`, notes };
  const headline = sorted.find((f) => f.curated && f.severity === top.severity) ?? top;
  const covered = (f: Finding) => f === headline || f.message === headline.message || (headline.curated && (f.verdict === top.verdict || f.verdict === headline.verdict));
  return {
    ...base,
    verdict: top.verdict,
    severity: top.severity,
    message: headline.message,
    notes: [...sorted.filter((f) => !covered(f)).map((f) => f.message), ...notes],
  };
}

// ---------------------------------------------------------------- entry points

export async function checkOne(raw: string, ctx: CheckContext): Promise<CheckResult> {
  const eco = ctx.ecosystem;
  const src: Sources = { ...LIVE, ...ctx.sources };
  const now = (ctx.now ?? new Date()).getTime();
  const { name, range } = parseSpec(eco, raw);
  const base: CheckResult = {
    name, requested: raw, range, ecosystem: eco, verdict: 'ok', severity: 'ok', message: '', version: null, resolved: null, publishedAt: null,
    ageDays: null, latest: null, wouldInstall: null, fixedIn: null, advisories: [], entry: null, alternatives: [], guide: null, notes: [], installScripts: [], unverified: false,
  };
  const withKnowledge = (res: CheckResult, findings: Finding[], notes: string[], version: string | null) => {
    const k = assessKnowledge(eco, name, version);
    const e = k.entry;
    // e18e suggestions are advice, not alarms: when something louder already applies they become notes.
    const louder = findings.some((f) => SEVERITY_RANK[f.severity] > SEVERITY_RANK.info);
    const advisory = !e && louder;
    return compose(
      { ...res, entry: e && { id: e.id, status: e.status, summary: e.summary, replacements: e.replacements, guide: e.guide, source: e.source }, guide: e?.guide ?? null, alternatives: k.alternatives },
      advisory ? findings : [...findings, ...k.findings],
      advisory ? [...notes, ...k.findings.map((f) => f.message), ...k.notes] : [...notes, ...k.notes],
    );
  };

  let pkg;
  try {
    pkg = await src.getPackage(eco, name, range);
  } catch (err) {
    if (err instanceof NotFound) {
      const registry = eco === 'npm' ? 'npm' : 'PyPI';
      return withKnowledge(base, [{ verdict: 'not-found', severity: 'block', message: `Likely hallucinated: not on the ${registry} registry. Do not install it or guess a similar name.` }], [], null);
    }
    return { ...base, verdict: 'error', severity: 'info', message: `Could not reach the registry (${(err as Error).message}). Verify manually.` };
  }

  const flavor = flavorOf(eco);
  let releases = history(pkg.versions, flavor, now);
  let outcome = select(releases, range, flavor, ctx.cooldownDays);
  const latestRelease = releases.find((x) => x.isDefault) ?? newest(releases.filter((x) => isStable(x.v)));
  const latest = latestRelease && { version: latestRelease.version, publishedAt: latestRelease.publishedAt, ageDays: Math.floor(latestRelease.ageDays) };

  // PyPI yanks aren't in deps.dev's data. A yanked pick is replaced by re-selecting without it (bounded).
  const yankMemo = new Map<string, Promise<string | null>>();
  const yanked = (r: Release): Promise<string | null> => {
    if (eco !== 'pypi') return Promise.resolve(null);
    let p = yankMemo.get(r.version);
    if (!p) yankMemo.set(r.version, (p = src.pypiYanked(name, r.version).catch(() => null)));
    return p;
  };
  for (let i = 0; i < 3 && outcome.ok && eco === 'pypi'; i++) {
    const sel = outcome.selection;
    const hits = (await Promise.all([...new Set([sel.resolved, sel.pick])].map(async (r) => [r, await yanked(r)] as const))).filter(([, y]) => y);
    if (!hits.length) break;
    releases = releases.map((x) => {
      const hit = hits.find(([r]) => r.version === x.version);
      return hit ? { ...x, yanked: hit[1]! } : x;
    });
    outcome = select(releases, range, flavor, ctx.cooldownDays);
  }
  if (!outcome.ok) return withKnowledge({ ...base, latest }, [outcome.finding], [], outcome.version ?? latest?.version ?? null);
  const sel = outcome.selection;

  const [security, adoption] = await Promise.all([
    assessSecurity(src, eco, pkg.name, sel, ctx.cooldownDays, ctx.exemptFresh, yanked),
    assessAdoption(src, eco, pkg.name, releases),
  ]);
  const pick = security.pick;
  const findings = [...security.findings];
  let fixedIn = security.fixedIn;
  let holdNote = security.pick === sel.pick ? sel.holdNote : null;

  // If security moved the pick, selection's "use X" advice no longer describes the result: replace it.
  let selFindings = sel.findings;
  if (pick !== sel.pick) {
    selFindings = sel.findings.filter((f) => f.verdict !== 'young');
    if (pick.ageDays < ctx.cooldownDays && !fixedIn && !security.doNotInstall) {
      findings.push({ verdict: 'young', severity: 'warn', message: `Review before pinning: ${pick.version} is only ${formatAge(pick.ageDays)} old, and the settled alternatives have high/critical advisories.` });
    }
  }

  // An unpinned install takes `wouldInstall` today. If that release is malware, pinning is not optional.
  if (!security.doNotInstall && compare(sel.wouldInstall.v, pick.v) > 0 && sel.wouldInstall.ageDays < ctx.cooldownDays) {
    const advs = await src.advisories(eco, pkg.name, sel.wouldInstall.version).catch((): Advisory[] => []);
    const mal = advs.find((a) => a.malicious);
    if (mal) {
      findings.push({ verdict: 'malicious', severity: 'block', message: `Pin ${pick.version}: ${sel.wouldInstall.version}, which an unpinned install takes today, is reported as malicious (${mal.id}).` });
      fixedIn ??= pick.version;
      holdNote = null;
    }
  }

  const install = ctx.fast || security.doNotInstall ? { scripts: [], findings: [], notes: [] } : await assessInstall(src, eco, pkg.name, pick.version);

  const res: CheckResult = {
    ...base,
    latest,
    wouldInstall: { version: sel.wouldInstall.version, ageDays: Math.round(sel.wouldInstall.ageDays * 100) / 100 },
    version: security.doNotInstall ? null : pick.version,
    resolved: sel.resolved.version,
    publishedAt: pick.publishedAt,
    ageDays: Math.floor(pick.ageDays),
    fixedIn,
    advisories: security.advisories,
    installScripts: install.scripts,
    unverified: !!security.unverified,
  };
  return withKnowledge(
    res,
    [...selFindings, ...findings, ...adoption, ...install.findings],
    [...security.notes, ...(holdNote ? [holdNote] : []), ...install.notes],
    sel.resolved.version,
  );
}

export function checkMany(specs: string[], ctx: CheckContext): Promise<CheckResult[]> {
  return mapLimit(specs, 6, (s) => checkOne(s, ctx));
}

/** Whether a result belongs on the suggested install line. */
export function installable(r: CheckResult): boolean {
  if (r.version === null) return false;
  if (r.verdict === 'vulnerable' || r.verdict === 'malicious') return r.fixedIn !== null;
  if (r.severity === 'block') return false;
  if (r.verdict === 'replace' || r.verdict === 'deprecated') return r.severity === 'info';
  return r.verdict !== 'unproven';
}
