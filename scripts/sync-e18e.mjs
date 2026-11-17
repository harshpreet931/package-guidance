// Vendors the e18e module-replacements dataset (MIT) into data/e18e.json.
// Usage: node scripts/sync-e18e.mjs [version]
import { writeFile } from 'node:fs/promises';

const version = process.argv[2] ?? (await (await fetch('https://registry.npmjs.org/module-replacements/latest')).json()).version;
const base = `https://cdn.jsdelivr.net/npm/module-replacements@${version}/manifests`;
const urlFor = (u) => {
  if (!u) return undefined;
  if (u.type === 'e18e') return `https://e18e.dev/docs/replacements/${u.id}`;
  if (u.type === 'mdn') return `https://developer.mozilla.org/en-US/docs/${u.id}`;
  if (u.type === 'node') return `https://nodejs.org/docs/latest/${u.id}`;
  return u.url ?? undefined;
};

const out = { source: `module-replacements@${version}`, license: 'MIT — https://github.com/es-tooling/module-replacements', mappings: {} };
for (const kind of ['native', 'micro-utilities', 'preferred']) {
  const res = await fetch(`${base}/${kind}.json`);
  if (!res.ok) throw new Error(`${kind}: HTTP ${res.status}`);
  const { mappings, replacements } = await res.json();
  for (const [name, m] of Object.entries(mappings)) {
    if (out.mappings[name]) continue; // first manifest wins: native > micro-utilities > preferred
    out.mappings[name] = {
      kind,
      url: urlFor(m.url),
      replacements: (m.replacements ?? []).map((id) => {
        const r = replacements[id] ?? { id, type: 'documented' };
        return { id, type: r.type, ...(r.description ? { description: r.description } : {}), ...(urlFor(r.url) ? { url: urlFor(r.url) } : {}) };
      }),
    };
  }
}
await writeFile(new URL('../data/e18e.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(`data/e18e.json ← ${out.source}: ${Object.keys(out.mappings).length} mappings`);
