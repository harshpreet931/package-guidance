import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Ecosystem } from './registry.ts';
import { normalizeName } from './registry.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface Replacement { name: string; kind: 'package' | 'native' | 'tool' | 'config'; install?: string; when?: string }

export interface Entry {
  id: string;
  ecosystem: Ecosystem;
  packages: string[];
  versions: string;
  status: 'deprecated' | 'sunset' | 'superseded' | 'outdated-major' | 'prefer-native' | 'caution';
  severity: 'block' | 'warn' | 'info';
  summary: string;
  replacements: Replacement[];
  guide?: string;
  tags?: string[];
  source: string;
  last_verified: string;
}

export interface E18eMapping {
  kind: 'native' | 'micro-utilities' | 'preferred';
  url?: string;
  replacements: { id: string; type: string; description?: string; url?: string }[];
}

let entries: Entry[] | null = null;
let e18e: { source: string; mappings: Record<string, E18eMapping> } | null = null;

export function loadEntries(): Entry[] {
  if (entries) return entries;
  entries = [];
  for (const eco of ['npm', 'pypi'] as const) {
    const dir = join(ROOT, 'data', 'entries', eco);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const e = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Entry;
        entries.push({ ...e, ecosystem: e.ecosystem ?? eco, versions: e.versions || '*', replacements: e.replacements ?? [] });
      } catch (err) {
        process.emitWarning(`package-guidance: skipping invalid entry ${eco}/${f}: ${(err as Error).message}`);
      }
    }
  }
  return entries;
}

export function entriesFor(eco: Ecosystem, name: string): Entry[] {
  const n = normalizeName(eco, name);
  return loadEntries().filter((e) => e.ecosystem === eco && e.packages.some((p) => normalizeName(eco, p) === n));
}

export function e18eFor(name: string): (E18eMapping & { source: string }) | null {
  if (!e18e) {
    try {
      e18e = JSON.parse(readFileSync(join(ROOT, 'data', 'e18e.json'), 'utf8'));
    } catch {
      e18e = { source: 'none', mappings: {} };
    }
  }
  const m = e18e!.mappings[name];
  return m ? { ...m, source: e18e!.source } : null;
}

// ---------- guides ----------

export interface Guide { id: string; title: string; body: string }

export function loadGuides(): Guide[] {
  const dir = join(ROOT, 'guides');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const body = readFileSync(join(dir, f), 'utf8');
      return { id: f.replace(/\.md$/, ''), title: /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? f, body };
    });
}

/** Rank guides + entries for a free-text query (cheap token scoring, no network). */
export function search(query: string): { guides: Guide[]; entries: Entry[] } {
  const terms = query.toLowerCase().split(/[^a-z0-9@/._-]+/).filter((t) => t.length > 1);
  const score = (text: string, boost: string) => {
    const t = text.toLowerCase();
    const b = boost.toLowerCase();
    return terms.reduce((s, term) => s + (b.includes(term) ? 5 : 0) + (t.includes(term) ? 1 : 0), 0);
  };
  const guides = loadGuides()
    .map((g) => ({ g, s: score(g.body, `${g.id} ${g.title}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.g);
  const ents = loadEntries()
    .map((e) => ({ e, s: score(`${e.summary} ${(e.tags ?? []).join(' ')} ${e.replacements.map((r) => r.name).join(' ')}`, `${e.id} ${e.packages.join(' ')}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e);
  return { guides, entries: ents };
}
