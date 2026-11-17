import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOne, sources, ctx } from './helpers.mjs';

test('OSV failing on the requested version is not presented as ok/settled', async () => {
  const s = sources({ packages: { pkg: [['1.0.0', 100, { latest: true }]] }, failOsv: new Set(['*']) });
  const r = await checkOne('pkg', ctx(s));
  assert.notEqual(r.verdict, 'ok', `verdict=${r.verdict} message="${r.message}"`);
  assert.notEqual(r.severity, 'ok');
});

test('OSV failing on the recommended upgrade is not treated as "no advisories"', async () => {
  const s = sources({ packages: { foo: [['1.5.0', 300], ['2.0.0', 30, { latest: true }]] }, failOsv: new Set(['foo@2.0.0']) });
  const r = await checkOne('foo@1', ctx(s));
  // The upgrade target was never checked; we must say so.
  assert.ok(r.notes.some((n) => /OSV|advisor/i.test(n) && /fail|unavailable|could not/i.test(n)), `notes: ${JSON.stringify(r.notes)} version=${r.version}`);
});

test('OSV failing on a fix candidate does not crash checkOne', async () => {
  const s = sources({
    packages: { pkg: [['1.0.0', 100], ['1.0.1', 50, { latest: true }]] },
    advisories: { 'pkg@1.0.0': [{ id: 'GHSA-1', summary: '', severity: 'high', malicious: false, url: '' }] },
    failOsv: new Set(['pkg@1.0.1']),
  });
  const r = await checkOne('pkg@1.0.0', ctx(s)).catch((e) => ({ crashed: e.message }));
  assert.ok(!r.crashed, `checkOne rejected: ${r.crashed}`);
  assert.equal(r.verdict, 'vulnerable');
});
