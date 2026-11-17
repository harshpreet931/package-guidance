// Preload (`node --import`) that replaces the network with fixtures, so CLI tests run offline.
// PG_FAKE is a JSON file: { packages: { "<eco>:<name>": [[version, ageDays, latest?]] }, osv: "ok" | "fail" | { "<name>@<version>": [vuln] },
//   npm: { "<name>": <packument> }, depsdev: { "<eco>:<name>": <deps.dev body> }, registry: "fail" (503 from deps.dev, npm and PyPI) }.
// Unknown packages are 404s. Every request is appended to PG_FAKE_LOG when set.
import { appendFileSync, readFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync(process.env.PG_FAKE, 'utf8'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ago = (d) => new Date(Date.now() - d * 86_400_000).toISOString();

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (process.env.PG_FAKE_LOG) appendFileSync(process.env.PG_FAKE_LOG, `${u.host}${u.pathname}\n`);
  if (fx.registry === 'fail' && /^(api\.deps\.dev|registry\.npmjs\.org|pypi\.org)$/.test(u.host)) return new Response('unavailable', { status: 503 });
  if (u.host === 'api.osv.dev') {
    if (fx.osv === 'fail') return new Response('unavailable', { status: 503 });
    const q = JSON.parse(init.body);
    return json({ vulns: (fx.osv ?? {})[`${q.package.name}@${q.version}`] ?? [] });
  }
  if (u.host === 'api.deps.dev') {
    const [, , , eco, , name] = u.pathname.split('/');
    const key = `${eco}:${decodeURIComponent(name)}`;
    if (fx.depsdev?.[key]) return json(fx.depsdev[key]);
    const rows = fx.packages?.[key];
    if (!rows) return json({ error: 'not found' }, 404);
    return json({ versions: rows.map(([v, age, latest]) => ({ versionKey: { version: v }, publishedAt: ago(age), isDefault: !!latest })) });
  }
  if (u.host === 'registry.npmjs.org') {
    const name = decodeURIComponent(u.pathname.slice(1));
    return fx.npm?.[name] ? json(fx.npm[name]) : json({ error: 'Not found' }, 404);
  }
  if (u.host === 'api.npmjs.org') return json({ downloads: 1_000_000 });
  return json({ error: 'not found' }, 404);
};
