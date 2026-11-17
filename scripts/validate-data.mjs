// Validates curated knowledge in data/ and guides/.
//
//   node scripts/validate-data.mjs                 schema + cross-references (offline, used in CI)
//   node scripts/validate-data.mjs --live          also re-check every entry against the registries
//   node scripts/validate-data.mjs --live --report data-report.md
//
// Exits 1 on schema errors. Live drift (stale entries, packages that vanished or changed deprecation
// status) is reported but does not fail, because the registries change underneath us by design.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const args = process.argv.slice(2);
const live = args.includes('--live');
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
const STALE_DAYS = 90;

const STATUS = ['deprecated', 'sunset', 'superseded', 'outdated-major', 'prefer-native', 'caution'];
const SEVERITY = ['block', 'warn', 'info'];
const KINDS = ['package', 'native', 'tool', 'config'];

const errors = [];
const drift = [];
const guides = new Set(existsSync(join(ROOT, 'guides')) ? readdirSync(join(ROOT, 'guides')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []);
const entries = [];
const ids = new Map();

for (const eco of ['npm', 'pypi']) {
  const dir = join(ROOT, 'data', 'entries', eco);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const where = `data/entries/${eco}/${file}`;
    let e;
    try {
      e = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      errors.push(`${where}: invalid JSON (${err.message})`);
      continue;
    }
    const need = (cond, msg) => cond || errors.push(`${where}: ${msg}`);
    need(typeof e.id === 'string' && `${e.id}.json` === file, `id must match the file name ("${e.id}")`);
    need(e.ecosystem === eco, `ecosystem must be "${eco}"`);
    need(Array.isArray(e.packages) && e.packages.length > 0 && e.packages.every((p) => typeof p === 'string'), 'packages must be a non-empty string array');
    need(typeof e.versions === 'string' && e.versions.length > 0, 'versions must be a range string ("*" for all)');
    need(STATUS.includes(e.status), `status must be one of ${STATUS.join(', ')}`);
    need(SEVERITY.includes(e.severity), `severity must be one of ${SEVERITY.join(', ')}`);
    need(typeof e.summary === 'string' && e.summary.length >= 10 && e.summary.length <= 320, 'summary must be 10–320 characters');
    need(Array.isArray(e.replacements), 'replacements must be an array');
    for (const r of e.replacements ?? []) need(typeof r.name === 'string' && KINDS.includes(r.kind), `replacement ${JSON.stringify(r.name)} needs a name and kind (${KINDS.join('|')})`);
    need(typeof e.source === 'string' && /^https:\/\//.test(e.source), 'source must be an https URL');
    need(/^\d{4}-\d{2}-\d{2}$/.test(e.last_verified ?? ''), 'last_verified must be YYYY-MM-DD');
    if (e.guide) need(guides.has(e.guide), `guide "${e.guide}" does not exist in guides/`);
    for (const p of e.packages ?? []) {
      const key = `${eco}:${p}:${e.versions}`;
      if (ids.has(key)) errors.push(`${where}: ${p} (${e.versions}) is also covered by ${ids.get(key)}`);
      ids.set(key, where);
    }
    const age = (Date.now() - Date.parse(e.last_verified)) / 86_400_000;
    if (age > STALE_DAYS) drift.push(`${where}: last verified ${Math.floor(age)} days ago`);
    entries.push({ ...e, where });
  }
}

if (live) {
  for (const e of entries) {
    for (const p of e.packages) {
      const url = e.ecosystem === 'npm' ? `https://registry.npmjs.org/${p.replace('/', '%2F')}/latest` : `https://pypi.org/pypi/${p}/json`;
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        if (res.status === 404) {
          // Some entries exist precisely because the name is not a package (stdlib modules agents try to install).
          if (!e.not_on_registry) drift.push(`${e.where}: ${p} no longer exists on the registry`);
          continue;
        }
        if (!res.ok) continue;
        const doc = await res.json();
        const deprecated = e.ecosystem === 'npm' ? !!doc.deprecated : !!doc.info?.yanked;
        if (deprecated && e.status !== 'deprecated' && e.severity !== 'block') drift.push(`${e.where}: ${p} is now deprecated on the registry; consider status "deprecated"`);
      } catch {
        /* transient network errors are not drift */
      }
    }
  }
}

const lines = [];
if (errors.length) lines.push('## Errors', ...errors.map((x) => `- ${x}`), '');
if (drift.length) lines.push('## Needs review', ...drift.map((x) => `- ${x}`), '');
lines.push(`Checked ${entries.length} entries and ${guides.size} guides${live ? ' against the live registries' : ''}.`);
const report = lines.join('\n');
console.log(report);
if (reportPath) writeFileSync(reportPath, `# Data refresh\n\n${report}\n`);
process.exit(errors.length ? 1 : 0);
