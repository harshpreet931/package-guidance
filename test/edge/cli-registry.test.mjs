// Offline (fetch is stubbed in-process): registry fallbacks and the response cache.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from './cli-run.mjs';

const { getPackage } = await dist('registry.js');
const { netOptions } = await dist('net.js');
netOptions.cache = false;

const ago = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
let routes;
let hits;
beforeEach(() => { hits = []; });
globalThis.fetch = async (url) => {
  const u = String(url);
  hits.push(new URL(u).host);
  for (const [prefix, body] of Object.entries(routes)) if (u.startsWith(prefix)) return typeof body === 'number' ? json({}, body) : json(body);
  return json({}, 404);
};

test('stale deps.dev: a range it cannot satisfy is re-checked against the npm registry', async () => {
  routes = {
    'https://api.deps.dev/v3/systems/npm/packages/zod': { versions: [{ versionKey: { version: '3.22.4' }, publishedAt: ago(800), isDefault: true }] },
    'https://registry.npmjs.org/zod': { 'dist-tags': { latest: '4.1.0' }, time: { '3.22.4': ago(800), '4.1.0': ago(30) }, versions: { '3.22.4': {}, '4.1.0': {} } },
  };
  const fresh = await getPackage('npm', 'zod', '4');
  assert.equal(fresh.source, 'registry');
  assert.ok(fresh.versions.some((v) => v.version === '4.1.0'));
  hits = [];
  const hot = await getPackage('npm', 'zod', '^3.20');
  assert.equal(hot.source, 'deps.dev');
  assert.deepEqual(hits, ['api.deps.dev'], 'no extra request when deps.dev satisfies the range');
});

test('versions with missing or invalid publish times are dropped (deps.dev, npm, PyPI)', async () => {
  routes = {
    'https://api.deps.dev/v3/systems/npm/packages/a': { versions: [{ versionKey: { version: '1.0.0' }, publishedAt: ago(100) }, { versionKey: { version: '2.0.0' }, publishedAt: 'garbage', isDefault: true }] },
    'https://api.deps.dev/v3/systems/pypi/packages/six': 503,
    'https://pypi.org/pypi/six/json': { info: { version: '2.0' }, releases: { '1.0': [{ upload_time_iso_8601: ago(100), yanked: false }], '2.0': [{ upload_time_iso_8601: null, yanked: false }], '3.0': [] } },
  };
  assert.deepEqual((await getPackage('npm', 'a')).versions.map((v) => v.version), ['1.0.0']);
  assert.deepEqual((await getPackage('pypi', 'six')).versions.map((v) => v.version), ['1.0']);
});

test('PyPI names are normalised and URL-encoded', async () => {
  routes = { 'https://api.deps.dev/v3/systems/pypi/packages/foo-bar': { versions: [{ versionKey: { version: '1.0' }, publishedAt: ago(100), isDefault: true }] } };
  assert.equal((await getPackage('pypi', 'Foo_Bar')).name, 'foo-bar');
});
