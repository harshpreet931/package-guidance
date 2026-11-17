const DIST = new URL('../../dist', import.meta.url).href;
export const { checkOne, installable } = await import(`${DIST}/check.js`);
export const { NotFound } = await import(`${DIST}/net.js`);
export const NOW = new Date('2026-11-16T12:00:00Z');
export const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
export function sources({ packages = {}, advisories = {}, downloads = {}, yanked = {}, failOsv = new Set() } = {}) {
  return {
    async getPackage(eco, name) {
      const rows = packages[name];
      if (!rows) throw new NotFound(name);
      return { ecosystem: eco, name, source: 'registry',
        versions: rows.map(([version, age, o = {}]) => ({ version, publishedAt: o.publishedAt ?? daysAgo(age), isDefault: !!o.latest, deprecated: o.deprecated ?? null })) };
    },
    async advisories(_eco, name, version) {
      if (failOsv.has('*') || failOsv.has(`${name}@${version}`)) throw new Error('OSV timeout');
      return advisories[`${name}@${version}`] ?? [];
    },
    async weeklyDownloads(_eco, name) { return downloads[name] ?? 1_000_000; },
    async npmInstallScripts() { return []; },
    async pypiYanked(name, version) { return yanked[`${name}@${version}`] ?? null; },
  };
}
export const ctx = (s, extra = {}) => ({ ecosystem: 'npm', cooldownDays: 7, cooldownSource: 'default', now: NOW, sources: s, ...extra });
export const HIGH = (id) => ({ id, summary: 'bad', severity: 'high', malicious: false, url: '' });
export const UNKNOWN = (id) => ({ id, summary: 'no severity', severity: 'unknown', malicious: false, url: '' });
export const MAL = (id) => ({ id, summary: 'malware', severity: 'critical', malicious: true, url: '' });
