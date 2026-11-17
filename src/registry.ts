import { NotFound, getJSON } from './net.ts';
import { parse, parseRange, satisfies } from './semver.ts';

// deps.dev is used first because it returns every version with its publish time in a compact form
// (~700 KB for typescript's 3,900 versions vs ~16 MB for the full npm packument).

export type Ecosystem = 'npm' | 'pypi';

export interface VersionInfo {
  version: string;
  publishedAt: string; // ISO
  isDefault: boolean; // the registry's "latest"
  deprecated: string | null; // reason, or null
}

export interface PackageInfo {
  ecosystem: Ecosystem;
  name: string;
  versions: VersionInfo[];
  source: 'deps.dev' | 'registry';
}

export const normalizeName = (eco: Ecosystem, name: string) =>
  eco === 'pypi' ? name.toLowerCase().replace(/[-_.]+/g, '-') : name;

interface DepsDevPackage {
  versions: { versionKey: { version: string }; publishedAt?: string; isDefault?: boolean; isDeprecated?: boolean; deprecatedReason?: string }[];
}

const hasTime = (t: string | null | undefined): t is string => !!t && !Number.isNaN(Date.parse(t));

/**
 * Version list with publish times. deps.dev first (small, fast), native registry as fallback. Throws NotFound.
 * Pass the requested `range` so a range deps.dev can't satisfy (it lags new releases by hours) is re-checked
 * against the registry instead of being reported as a hallucinated version.
 */
export async function getPackage(eco: Ecosystem, rawName: string, range?: string | null): Promise<PackageInfo> {
  const name = normalizeName(eco, rawName);
  try {
    const d = await getJSON<DepsDevPackage>(`https://api.deps.dev/v3/systems/${eco}/packages/${encodeURIComponent(name)}`);
    const versions = d.versions
      .filter((v) => hasTime(v.publishedAt))
      .map((v) => ({
        version: v.versionKey.version,
        publishedAt: v.publishedAt!,
        isDefault: !!v.isDefault,
        deprecated: v.isDeprecated ? v.deprecatedReason || 'deprecated' : null,
      }));
    if (versions.length && !missesRange(eco, versions, range)) return { ecosystem: eco, name, versions, source: 'deps.dev' };
  } catch {
    // deps.dev lags brand-new packages by hours and can be unavailable. The registry is the
    // source of truth, so fall through to it for both "not found" and transport errors.
  }
  return eco === 'npm' ? npmFallback(name) : pypiFallback(name);
}

/** True when a parseable range matches none of the listed versions (prereleases included, to stay conservative). */
function missesRange(eco: Ecosystem, versions: VersionInfo[], range?: string | null): boolean {
  if (!range) return false;
  const flavor = eco === 'npm' ? 'npm' : 'pep440';
  const r = parseRange(range, flavor);
  if (!r) return false;
  return !versions.some((x) => {
    const v = parse(x.version, flavor);
    return v !== null && satisfies(v, r, { includePrerelease: true });
  });
}

async function npmFallback(name: string): Promise<PackageInfo> {
  const doc = await getJSON<{ 'dist-tags'?: Record<string, string>; time?: Record<string, string>; versions?: Record<string, { deprecated?: string }> }>(
    `https://registry.npmjs.org/${name.replace('/', '%2F')}`,
  );
  const latest = doc['dist-tags']?.latest;
  // A version without a publish time has unknown age: it can't be shown to have settled, so it is left out
  // (deps.dev does the same) rather than dated to 1970 and treated as decades old.
  const versions = Object.entries(doc.versions ?? {}).filter(([version]) => hasTime(doc.time?.[version])).map(([version, v]) => ({
    version,
    publishedAt: doc.time![version]!,
    isDefault: version === latest,
    deprecated: v.deprecated ?? null,
  }));
  if (!Object.keys(doc.versions ?? {}).length) throw new NotFound(name); // unpublished
  if (!versions.length) throw new Error('the registry lists no publish times for this package');
  return { ecosystem: 'npm', name, versions, source: 'registry' };
}

async function pypiFallback(name: string): Promise<PackageInfo> {
  const doc = await getJSON<{ info: { version: string }; releases: Record<string, { upload_time_iso_8601: string; yanked: boolean; yanked_reason?: string | null }[]> }>(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
  );
  // A release whose files carry no upload time has unknown age, so it is left out (as for npm).
  const versions = Object.entries(doc.releases ?? {})
    .map(([version, files]) => [version, (files ?? []).filter((f) => hasTime(f.upload_time_iso_8601))] as const)
    .filter(([, files]) => files.length)
    .map(([version, files]) => ({
      version,
      publishedAt: files.map((f) => f.upload_time_iso_8601).sort()[0]!,
      isDefault: version === doc.info?.version,
      deprecated: files.every((f) => f.yanked) ? `yanked${files[0]?.yanked_reason ? `: ${files[0].yanked_reason}` : ''}` : null,
    }));
  if (!versions.length) throw new NotFound(name);
  return { ecosystem: 'pypi', name, versions, source: 'registry' };
}

/** npm lifecycle scripts that run on install for a specific version (empty if none / unknown). */
export async function npmInstallScripts(name: string, version: string): Promise<string[]> {
  try {
    const doc = await getJSON<{ scripts?: Record<string, string> }>(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`, { ttl: 24 * 3600e3 });
    return ['preinstall', 'install', 'postinstall'].filter((s) => doc.scripts?.[s]);
  } catch {
    return [];
  }
}

/** PyPI: is this exact release yanked? */
export async function pypiYanked(name: string, version: string): Promise<string | null> {
  try {
    const doc = await getJSON<{ info: { yanked: boolean; yanked_reason: string | null } }>(`https://pypi.org/pypi/${name}/${version}/json`, { ttl: 24 * 3600e3 });
    return doc.info.yanked ? doc.info.yanked_reason || 'yanked' : null;
  } catch {
    return null;
  }
}

/** Weekly downloads (npm only; PyPI has no unauthenticated, reliable equivalent). */
export async function weeklyDownloads(eco: Ecosystem, name: string): Promise<number | null> {
  if (eco !== 'npm') return null;
  try {
    const d = await getJSON<{ downloads: number }>(`https://api.npmjs.org/downloads/point/last-week/${name}`, { ttl: 24 * 3600e3 });
    return d.downloads;
  } catch {
    return null;
  }
}
