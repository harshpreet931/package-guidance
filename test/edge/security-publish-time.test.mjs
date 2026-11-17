import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PACKAGE_GUIDANCE_NO_CACHE = '1';
const D = new URL('../../dist', import.meta.url).href;
const { netOptions } = await import(`${D}/net.js`);
netOptions.cache = false;
const { checkOne } = await import(`${D}/check.js`);
const { getPackage } = await import(`${D}/registry.js`);

const NOW = new Date('2026-11-16T12:00:00Z');
const iso = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
function stubNpm(doc) {
  globalThis.fetch = async (url) => String(url).includes('deps.dev')
    ? new Response('{}', { status: 503 })
    : new Response(JSON.stringify(doc), { status: 200 });
}

test('npm fallback: a version with no publish time is not treated as decades-old and settled', async () => {
  stubNpm({ 'dist-tags': { latest: '1.0.1' }, time: { '1.0.0': iso(100) }, versions: { '1.0.0': {}, '1.0.1': {} } });
  const r = await checkOne('pkg', {
    ecosystem: 'npm', cooldownDays: 7, cooldownSource: 'default', now: NOW,
    sources: { getPackage, advisories: async () => [], weeklyDownloads: async () => 1e6, npmInstallScripts: async () => [], pypiYanked: async () => null },
  });
  assert.equal(r.version, '1.0.0', `picked ${r.version}, ageDays=${r.ageDays}`);
});
