import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOne, installable } from '../dist/check.js';
import { NotFound } from '../dist/net.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

/** Tiny in-memory registry: { name: [[version, ageDays, { latest?, deprecated? }]] } */
function sources({ packages = {}, advisories = {}, downloads = {} } = {}) {
  return {
    async getPackage(eco, name) {
      const rows = packages[name];
      if (!rows) throw new NotFound(name);
      return {
        ecosystem: eco, name, source: 'registry',
        versions: rows.map(([version, age, o = {}]) => ({ version, publishedAt: daysAgo(age), isDefault: !!o.latest, deprecated: o.deprecated ?? null })),
      };
    },
    async advisories(_eco, name, version) { return advisories[`${name}@${version}`] ?? []; },
    async weeklyDownloads(_eco, name) { return downloads[name] ?? 1_000_000; },
    async npmInstallScripts() { return []; },
    async pypiYanked() { return null; },
  };
}
const ctx = (s, extra = {}) => ({ ecosystem: 'npm', cooldownDays: 7, cooldownSource: 'default', now: NOW, sources: s, ...extra });
const HIGH = (id) => ({ id, summary: 'bad', severity: 'high', malicious: false, url: '' });

test('picks the newest settled version, not the brand-new latest', async () => {
  const s = sources({ packages: { next: [['16.4.4', 30], ['16.4.5', 12], ['16.4.6', 2, { latest: true }]] } });
  const r = await checkOne('next', ctx(s));
  assert.equal(r.verdict, 'ok');
  assert.equal(r.version, '16.4.5');
  assert.match(r.notes.join(' '), /holding at 16\.4\.5/);
  assert.ok(installable(r));
});

test('a 404 is a hallucination and is blocked', async () => {
  const r = await checkOne('reqeusts-pro', ctx(sources()));
  assert.equal(r.verdict, 'not-found');
  assert.equal(r.severity, 'block');
  assert.equal(installable(r), false);
});

test('a range that matches nothing is a hallucinated version', async () => {
  const s = sources({ packages: { zod: [['3.25.0', 400], ['4.1.0', 60, { latest: true }]] } });
  const r = await checkOne('zod@5', ctx(s));
  assert.equal(r.verdict, 'not-found');
});

test('registry-deprecated packages are blocked', async () => {
  const s = sources({ packages: { request: [['2.88.2', 2000, { latest: true, deprecated: 'request has been deprecated' }]] } });
  const r = await checkOne('request', ctx(s));
  assert.equal(r.verdict, 'deprecated');
  assert.equal(r.severity, 'block');
});

test('an old major is outdated and the upgrade is recommended', async () => {
  const s = sources({ packages: { tailwindcss: [['3.4.19', 300], ['4.3.5', 40, { latest: true }]] } });
  const r = await checkOne('tailwindcss@3', ctx(s));
  assert.equal(r.verdict, 'outdated');
  assert.equal(r.resolved, '3.4.19');
  assert.equal(r.version, '4.3.5');
});

test('a vulnerable pin gets a settled fix on the same major', async () => {
  const s = sources({
    packages: { lodash: [['4.17.20', 2000], ['4.17.21', 1800], ['4.18.1', 60, { latest: true }]] },
    advisories: { 'lodash@4.17.20': [HIGH('GHSA-1')] },
  });
  const r = await checkOne('lodash@4.17.20', ctx(s));
  assert.equal(r.verdict, 'vulnerable');
  assert.equal(r.severity, 'block');
  assert.equal(r.fixedIn, '4.18.1');
  assert.ok(installable(r), 'the fixed version goes on the install line');
});

test('security fixes may skip the cooldown when the request allows them', async () => {
  const s = sources({
    packages: { pkg: [['1.0.0', 100], ['1.0.1', 1, { latest: true }]] },
    advisories: { 'pkg@1.0.0': [HIGH('GHSA-2')] },
  });
  const r = await checkOne('pkg', ctx(s));
  assert.equal(r.version, '1.0.1');
  assert.equal(r.fixedIn, '1.0.1');
  assert.equal(r.verdict, 'vulnerable', 'never reported as a plain "ok · settled"');
  assert.equal(r.severity, 'warn', 'the request already allows the fix, so this informs rather than blocks');
  assert.match(r.message, /Use 1\.0\.1: 1\.0\.0 has 1 high\/critical advisory\. 1\.0\.1 is a security fix only 1d old/);
  assert.ok(installable(r));
});

test('vulnerable with no fix anywhere is not installable', async () => {
  const s = sources({ packages: { pkg: [['1.0.0', 100, { latest: true }]] }, advisories: { 'pkg@1.0.0': [HIGH('GHSA-3')] } });
  const r = await checkOne('pkg', ctx(s));
  assert.equal(r.verdict, 'vulnerable');
  assert.equal(r.version, null);
});

const MAL = { id: 'MAL-2025-1', summary: 'malware', severity: 'critical', malicious: true, url: '' };

test('a malicious release is never installed; the clean release before it is pinned', async () => {
  const s = sources({ packages: { chalk: [['5.6.0', 400], ['5.6.1', 30, { latest: true }]] }, advisories: { 'chalk@5.6.1': [MAL] } });
  for (const spec of ['chalk@5.6.1', 'chalk']) {
    const r = await checkOne(spec, ctx(s));
    assert.equal(r.verdict, 'malicious', spec);
    assert.equal(r.severity, 'block', spec);
    assert.equal(r.version, '5.6.0', spec);
    assert.match(r.message, /5\.6\.1 is reported as malicious \(MAL-2025-1\)/, spec);
  }
});

test('a package whose every release is malicious is not installable', async () => {
  const s = sources({ packages: { evil: [['1.0.0', 400, { latest: true }]] }, advisories: { 'evil@1.0.0': [MAL] } });
  const r = await checkOne('evil', ctx(s));
  assert.equal(r.verdict, 'malicious');
  assert.equal(r.version, null);
  assert.equal(installable(r), false);
});

test('a malicious fresh latest makes pinning mandatory, not just a hold', async () => {
  const s = sources({ packages: { colorlib: [['5.6.0', 400], ['5.6.1', 1, { latest: true }]] }, advisories: { 'colorlib@5.6.1': [MAL] } });
  const r = await checkOne('colorlib', ctx(s));
  assert.equal(r.version, '5.6.0');
  assert.equal(r.verdict, 'malicious');
  assert.equal(r.severity, 'block');
  assert.doesNotMatch(r.notes.join(' '), /holding at/);
});

test('an OSV failure is never presented as safe', async () => {
  const s = { ...sources({ packages: { lib: [['1.0.0', 100, { latest: true }]] } }), async advisories() { throw new Error('ECONNRESET'); } };
  const r = await checkOne('lib', ctx(s));
  assert.notEqual(r.verdict, 'ok');
  assert.equal(r.severity, 'warn');
  assert.match(r.message, /Unverified: the advisory lookup \(OSV\) failed/);
});

test('brand-new, barely downloaded packages look like slopsquats', async () => {
  const s = sources({ packages: { 'react-codeshift': [['1.0.0', 5, { latest: true }]] }, downloads: { 'react-codeshift': 12 } });
  const r = await checkOne('react-codeshift', ctx(s));
  assert.equal(r.verdict, 'young');
  assert.equal(r.severity, 'warn');
});

test('old packages with near-zero downloads are unproven and kept off the install line', async () => {
  const s = sources({ packages: { 'unused-imports': [['1.0.0', 300, { latest: true }]] }, downloads: { 'unused-imports': 40 } });
  const r = await checkOne('unused-imports', ctx(s));
  assert.equal(r.verdict, 'unproven');
  assert.equal(installable(r), false);
});

test('when nothing is settled the newest version is flagged young', async () => {
  const s = sources({ packages: { fresh: [['0.1.0', 2, { latest: true }]] }, downloads: { fresh: 50_000 } });
  const r = await checkOne('fresh', ctx(s));
  assert.equal(r.verdict, 'young');
  assert.equal(r.version, '0.1.0');
});

test('e18e knows native replacements', async () => {
  const s = sources({ packages: { 'node-fetch': [['3.3.2', 900, { latest: true }]] } });
  const r = await checkOne('node-fetch', ctx(s));
  assert.equal(r.verdict, 'replace');
  assert.ok(r.alternatives.some((a) => a.startsWith('fetch')));
});

test('a cooldown of 0 takes the latest', async () => {
  const s = sources({ packages: { next: [['16.4.5', 12], ['16.4.6', 2, { latest: true }]] } });
  const r = await checkOne('next', ctx(s, { cooldownDays: 0 }));
  assert.equal(r.version, '16.4.6');
});

test('PyPI names normalise and pip specifiers work', async () => {
  const s = sources({ packages: { pydantic: [['1.10.27', 200], ['2.14.3', 30, { latest: true }]] } });
  const r = await checkOne('Pydantic<2', ctx(s, { ecosystem: 'pypi' }));
  assert.equal(r.name, 'pydantic');
  assert.equal(r.verdict, 'outdated');
  assert.equal(r.resolved, '1.10.27');
});

// ---- regressions from the independent review

test('wouldInstall reports what the package manager would take for a range (#5)', async () => {
  const s = sources({ packages: { foo: [['1.2.3', 60], ['1.2.4', 0.1, { latest: true }]] } });
  const r = await checkOne('foo@^1', ctx(s));
  assert.equal(r.wouldInstall.version, '1.2.4');
  assert.equal(r.version, '1.2.3');
});

test('an exact pin to a fresh release falls back to the newest settled one (#5)', async () => {
  const s = sources({ packages: { foo: [['1.2.3', 60], ['1.2.4', 0.1, { latest: true }]] } });
  const r = await checkOne('foo@1.2.4', ctx(s));
  assert.equal(r.verdict, 'young');
  assert.equal(r.version, '1.2.3');
  assert.equal(r.wouldInstall.version, '1.2.4');
});

test('an outdated-major upgrade is never to a version with high advisories (#6)', async () => {
  const s = sources({
    packages: { foo: [['1.5.0', 300], ['2.0.0', 30, { latest: true }]] },
    advisories: { 'foo@2.0.0': [HIGH('GHSA-x')] },
  });
  const r = await checkOne('foo@1', ctx(s));
  assert.equal(r.version, '1.5.0');
  assert.ok(!r.notes.some((n) => /low\/moderate/.test(n) && n.includes('GHSA-x')));
});

test('a security exception is not contradicted by a "holding" note, and records fixedIn (#16)', async () => {
  const s = sources({
    packages: { pkg: [['1.0.0', 100], ['1.0.1', 1, { latest: true }]] },
    advisories: { 'pkg@1.0.0': [HIGH('GHSA-2')] },
  });
  const r = await checkOne('pkg', ctx(s));
  assert.equal(r.version, '1.0.1');
  assert.equal(r.fixedIn, '1.0.1');
  assert.ok(!r.notes.some((n) => n.includes('holding')));
});

test('PEP 440 == is exact, not a prefix (#7)', async () => {
  const s = sources({ packages: { pyyaml: [['5.3', 2000], ['5.3.1', 1900], ['6.0.2', 400, { latest: true }]] }, advisories: { 'pyyaml@5.3': [HIGH('GHSA-8q59')] } });
  const r = await checkOne('pyyaml==5.3', ctx(s, { ecosystem: 'pypi' }));
  assert.equal(r.resolved, '5.3');
  assert.equal(r.verdict, 'vulnerable');
});

test('security exception takes the first patched fresh release, not the newest one', async () => {
  // 1.0.0 is settled and vulnerable; 1.0.1 fixes it (3d old); 1.0.2 appeared hours later (could be a worm riding the fix).
  const s = sources({
    packages: { lib: [['1.0.0', 40], ['1.0.1', 3], ['1.0.2', 0.2, { latest: true }]] },
    advisories: { 'lib@1.0.0': [HIGH('GHSA-fix-me')] },
  });
  const r = await checkOne('lib', ctx(s));
  assert.equal(r.version, '1.0.1');
  assert.equal(r.fixedIn, '1.0.1');
});

test('a fresh security fix tells you how to let it through your own cooldown', async () => {
  const s = sources({
    packages: { lib: [['1.0.0', 40], ['1.0.1', 2, { latest: true }]] },
    advisories: { 'lib@1.0.0': [HIGH('GHSA-fix-me')] },
  });
  const hint = (name, v) => `exempt ${name}@${v}`;
  const configured = await checkOne('lib', ctx(s, { exemptFresh: hint }));
  assert.equal(configured.version, '1.0.1');
  assert.match(configured.notes.join(' '), /exempt lib@1\.0\.1/);
  const unconfigured = await checkOne('lib', ctx(s));
  assert.doesNotMatch(unconfigured.notes.join(' '), /exempt/, 'no hint when the repo has no cooldown of its own');
});
