import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PACKAGE_GUIDANCE_NO_CACHE = '1';
const { advisories } = await import(new URL('../../dist', import.meta.url).href + '/osv.js');
const { netOptions } = await import(new URL('../../dist', import.meta.url).href + '/net.js');
netOptions.cache = false;
const withVulns = async (vulns) => {
  globalThis.fetch = async () => new Response(JSON.stringify({ vulns }), { status: 200, headers: { 'content-type': 'application/json' } });
  return advisories('npm', 'x', '1.0.0');
};

test('a GHSA malware record listed before its MAL- alias is still malicious', async () => {
  const a = await withVulns([
    { id: 'GHSA-mmmm', aliases: ['MAL-2025-9'], summary: 'Malware in x', database_specific: { severity: 'CRITICAL' } },
    { id: 'MAL-2025-9', aliases: ['GHSA-mmmm'], summary: 'Malicious code in x' },
  ]);
  assert.equal(a.length, 1);
  assert.equal(a[0].malicious, true, JSON.stringify(a));
});

test('merging keeps the MAL- id rather than replacing it with GHSA', async () => {
  const a = await withVulns([
    { id: 'MAL-2025-9', aliases: ['GHSA-mmmm'], summary: 'Malicious code in x' },
    { id: 'GHSA-mmmm', aliases: ['MAL-2025-9'], summary: 'Malware in x', database_specific: { severity: 'CRITICAL' } },
  ]);
  assert.match(a[0].id, /^MAL-/, JSON.stringify(a));
});

test('CVSS 3.1 7.5 (A:H only, ReDoS/DoS) without a label is high, not moderate', async () => {
  const a = await withVulns([{ id: 'PYSEC-1', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }] }]);
  assert.equal(a[0].severity, 'high');
});

test('CVSS 3.1 9.8 is critical, not high', async () => {
  const a = await withVulns([{ id: 'PYSEC-2', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }]);
  assert.equal(a[0].severity, 'critical');
});

test('a withdrawn advisory is ignored', async () => {
  const a = await withVulns([{ id: 'GHSA-w', withdrawn: '2025-01-01T00:00:00Z', database_specific: { severity: 'HIGH' } }]);
  assert.equal(a.length, 0, JSON.stringify(a));
});

test('a record whose MAL- id is only an alias (no severity) is malicious and serious', async () => {
  const a = await withVulns([{ id: 'GHSA-only', aliases: ['MAL-2025-7'], summary: 'Malicious code' }]);
  assert.equal(a[0].malicious, true, JSON.stringify(a));
  assert.equal(a[0].severity, 'critical');
});
