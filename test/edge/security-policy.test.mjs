import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOne, installable, sources, ctx, HIGH, UNKNOWN, MAL } from './helpers.mjs';

test('dist-tag latest rolled back: a ranged request must not resolve above `latest`', async () => {
  // Maintainers moved `latest` back to 1.2.0 after a bad 1.3.0. npm install pkg@^1 takes 1.2.0.
  const s = sources({ packages: { pkg: [['1.2.0', 60, { latest: true }], ['1.3.0', 30]] } });
  const r = await checkOne('pkg@^1', ctx(s));
  assert.equal(r.wouldInstall.version, '1.2.0');
  assert.equal(r.version, '1.2.0', `recommended ${r.version}, which npm would not install and maintainers untagged`);
});

test('only fresh versions: pick the most-aged one, not the one published an hour ago', async () => {
  const s = sources({ packages: { pkg: [['1.0.0', 5], ['1.0.1', 0.04, { latest: true }]] } });
  const r = await checkOne('pkg', ctx(s));
  assert.equal(r.version, '1.0.0', `picked ${r.version}; message: ${r.message}`);
});

test('young fallback replaced by a security move: headline must not say "Use <fallback>"', async () => {
  // exact pin to a fresh, clean 1.2.4; the settled fallback 1.2.3 has a high advisory
  const s = sources({ packages: { foo: [['1.2.3', 60], ['1.2.4', 0.1, { latest: true }]] }, advisories: { 'foo@1.2.3': [HIGH('GHSA-a')] } });
  const r = await checkOne('foo@1.2.4', ctx(s));
  assert.ok(!(r.message.includes('Use 1.2.3') && r.version !== '1.2.3'), `message "${r.message}" but version=${r.version}`);
});

test('security exception to a fresh fix is not reported as ok/"settled"', async () => {
  const s = sources({ packages: { pkg: [['1.0.0', 100], ['1.0.1', 1, { latest: true }]] }, advisories: { 'pkg@1.0.0': [HIGH('GHSA-2')] } });
  const r = await checkOne('pkg', ctx(s));
  assert.equal(r.version, '1.0.1');
  assert.ok(!/settled/.test(r.message), `verdict=${r.verdict} message="${r.message}"`);
  assert.notEqual(r.verdict, 'ok');
});

test('a settled-but-malicious newest release: fall back to the previous clean release', async () => {
  const s = sources({ packages: { colorlib: [['5.6.0', 400], ['5.6.1', 10, { latest: true }]] }, advisories: { 'colorlib@5.6.1': [MAL('MAL-2025-1')] } });
  const r = await checkOne('colorlib', ctx(s));
  assert.equal(r.version, '5.6.0', `verdict=${r.verdict} version=${r.version} message="${r.message}"`);
});

test('a fresh malicious latest is not described as "holding until it settles"', async () => {
  const s = sources({ packages: { colorlib: [['5.6.0', 400], ['5.6.1', 1, { latest: true }]] }, advisories: { 'colorlib@5.6.1': [MAL('MAL-2025-1')] } });
  const r = await checkOne('colorlib', ctx(s));
  const all = [r.message, ...r.notes].join(' | ');
  assert.ok(/malicious|MAL-/.test(all), `no malware warning about what \`npm install colorlib\` takes today: ${all}`);
  assert.ok(!/until it settles/.test(all), all);
});

test('no newer fix, but an older release is unaffected: do not block the whole package', async () => {
  // advisory introduced in 1.5.0 (all 1.5+ affected), 1.4.0 is clean
  const s = sources({ packages: { pkg: [['1.4.0', 400], ['1.5.0', 200], ['1.6.0', 100, { latest: true }]] },
    advisories: { 'pkg@1.5.0': [HIGH('GHSA-r')], 'pkg@1.6.0': [HIGH('GHSA-r')] } });
  const r = await checkOne('pkg', ctx(s));
  assert.ok(r.version !== null, `version=null; message="${r.message}"`);
});

test('settled same-major search looks past the two newest', async () => {
  // 1.0.0 vuln A; 1.1.0 clean; 1.2.0 and 1.3.0 have a new advisory B; no 2.x
  const s = sources({ packages: { pkg: [['1.0.0', 900], ['1.1.0', 600], ['1.2.0', 300], ['1.3.0', 100, { latest: true }]] },
    advisories: { 'pkg@1.0.0': [HIGH('A')], 'pkg@1.2.0': [HIGH('B')], 'pkg@1.3.0': [HIGH('B')] } });
  const r = await checkOne('pkg@1.0.0', ctx(s));
  assert.equal(r.version, '1.1.0', `version=${r.version} message="${r.message}"`);
});

test('fix only in a fresh new major: message must not claim "no fixed version"', async () => {
  const s = sources({ packages: { pkg: [['1.5.0', 300], ['2.0.0', 2, { latest: true }]] }, advisories: { 'pkg@1.5.0': [HIGH('G')] } });
  const r = await checkOne('pkg@^1', ctx(s));
  assert.ok(!/no fixed version/.test(r.message), `message="${r.message}"`);
});

test('fix only in a newer major: say it is a major upgrade outside the request', async () => {
  const s = sources({ packages: { pkg: [['1.5.0', 300], ['2.0.0', 60, { latest: true }]] }, advisories: { 'pkg@1.5.0': [HIGH('G')] } });
  const r = await checkOne('pkg@^1', ctx(s));
  assert.equal(r.version, '2.0.0');
  assert.ok(/major|breaking|outside|\^1/i.test([r.message, ...r.notes].join(' ')), `message="${r.message}" notes=${JSON.stringify(r.notes)}`);
});

test('a yanked (PyPI) security fix is not put on the install line', async () => {
  const s = sources({ packages: { lib: [['1.0.0', 300], ['1.0.1', 100], ['1.0.2', 60, { latest: true }]] },
    advisories: { 'lib@1.0.0': [HIGH('G')] }, yanked: { 'lib@1.0.2': 'broken build' } });
  const r = await checkOne('lib==1.0.0', ctx(s, { ecosystem: 'pypi' }));
  assert.ok(!(installable(r) && r.version === '1.0.2'), `installable yanked fix ${r.version}; verdict=${r.verdict}`);
});

test('a yanked settled pick falls back to the previous release instead of blocking', async () => {
  const s = sources({ packages: { lib: [['1.0.0', 300], ['1.0.1', 60, { latest: true }]] }, yanked: { 'lib@1.0.1': 'broken' } });
  const r = await checkOne('lib', ctx(s, { ecosystem: 'pypi' }));
  assert.ok(installable(r) && r.version === '1.0.0', `version=${r.version} verdict=${r.verdict} installable=${installable(r)}`);
});

test('an advisory with unknown severity is not described as "low/moderate"', async () => {
  const s = sources({ packages: { pkg: [['1.0.0', 100, { latest: true }]] }, advisories: { 'pkg@1.0.0': [UNKNOWN('PYSEC-2024-1')] } });
  const r = await checkOne('pkg', ctx(s));
  assert.ok(!r.notes.some((n) => /low\/moderate/.test(n)), `verdict=${r.verdict} notes=${JSON.stringify(r.notes)}`);
});

test('PEP 440 epoch: 1!1.0 is newer than 2.0 and must not be flagged outdated', async () => {
  const s = sources({ packages: { calv: [['2024.1', 400], ['1!1.0', 100, { latest: true }]] } });
  const r = await checkOne('calv', ctx(s, { ecosystem: 'pypi' }));
  assert.equal(r.version, '1!1.0');
  assert.notEqual(r.verdict, 'outdated', r.message);
});

test('PEP 440 epoch: a ranged request on the new epoch is not told an older epoch is "current"', async () => {
  const s = sources({ packages: { calv: [['2024.1', 400], ['1!1.0', 100, { latest: true }]] } });
  const r = await checkOne('calv>=1!1.0', ctx(s, { ecosystem: 'pypi' }));
  assert.notEqual(r.verdict, 'outdated', r.message);
});

test('a future publish date (clock skew) is not "<1d" without saying so; and huge cooldown keeps the oldest', async () => {
  const s = sources({ packages: { pkg: [['1.0.0', 400], ['1.1.0', 200, { latest: true }]] } });
  const r = await checkOne('pkg', ctx(s, { cooldownDays: 100000 }));
  assert.equal(r.version, '1.0.0', `huge cooldown picked ${r.version}: ${r.message}`);
});

test('exact pin to a fresh vulnerable release: the clean settled fallback is offered, not a block', async () => {
  const s = sources({ packages: { foo: [['1.2.3', 60], ['1.2.4', 0.5, { latest: true }]] }, advisories: { 'foo@1.2.4': [HIGH('GHSA-z')] } });
  const r = await checkOne('foo@1.2.4', ctx(s));
  assert.equal(r.version, '1.2.3', `version=${r.version} message="${r.message}"`);
});

test('fix outside a tilde range is flagged as outside the request', async () => {
  const s = sources({ packages: { pkg: [['1.2.5', 300], ['1.3.0', 60, { latest: true }]] }, advisories: { 'pkg@1.2.5': [HIGH('G')] } });
  const r = await checkOne('pkg@~1.2.0', ctx(s));
  assert.equal(r.version, '1.3.0');
  assert.ok(/outside|~1\.2\.0|minor/i.test([r.message, ...r.notes].join(' ')), `message="${r.message}" notes=${JSON.stringify(r.notes)}`);
});
