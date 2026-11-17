import { getJSON } from './net.ts';
import type { Ecosystem } from './registry.ts';

export interface Advisory {
  id: string;
  summary: string;
  severity: 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
  malicious: boolean;
  url: string;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  severity?: { type: string; score: string }[];
  withdrawn?: string;
}

const ECO = { npm: 'npm', pypi: 'PyPI' } as const;
const RANK: Record<Advisory['severity'], number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 };

/** Strip control characters (incl. terminal escapes) from text that came from a registry or advisory feed. */
export const sanitize = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();

const band = (score: number): Advisory['severity'] =>
  score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'unknown';

/** CVSS 3.x "Roundup": the smallest number with one decimal that is >= x (spec, avoiding float error). */
const roundup = (x: number) => {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
};

/** CVSS 3.0/3.1 base score, computed exactly as the specification defines it. */
export function cvss3Score(vector: string): number | null {
  const m = Object.fromEntries(vector.split('/').map((p) => p.split(':') as [string, string]));
  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
    CIA: { H: 0.56, L: 0.22, N: 0 },
  } as const;
  const changed = m.S === 'C';
  const PR = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 } as Record<string, number>;
  const get = <T extends Record<string, number>>(t: T, k: string | undefined) => (k !== undefined && k in t ? t[k as keyof T] : undefined);
  const av = get(W.AV, m.AV), ac = get(W.AC, m.AC), ui = get(W.UI, m.UI), pr = m.PR !== undefined ? PR[m.PR] : undefined;
  const c = get(W.CIA, m.C), i = get(W.CIA, m.I), a = get(W.CIA, m.A);
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined) || !(m.S === 'U' || changed)) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av! * ac! * pr! * ui!;
  return roundup(Math.min(changed ? 1.08 * (impact + exploit) : impact + exploit, 10));
}

/**
 * Severity from a CVSS vector or a bare score. v3 vectors are scored exactly. v4 has no closed-form score, so it
 * is judged conservatively: a network-reachable high impact on the vulnerable or a subsequent system is "high".
 */
function cvssSeverity(vector: string): Advisory['severity'] {
  const score = Number(/^(\d+(?:\.\d+)?)$/.exec(vector)?.[1]);
  if (Number.isFinite(score)) return band(score);
  if (/^CVSS:3\.[01]\//.test(vector)) {
    const s = cvss3Score(vector);
    if (s !== null) return band(s);
  }
  const has = (k: string, v: string) => new RegExp(`/${k}:${v}(/|$)`).test(vector);
  const highImpact = ['VC', 'VI', 'VA', 'SC', 'SI', 'SA', 'C', 'I', 'A'].some((k) => has(k, 'H'));
  const lowImpact = ['VC', 'VI', 'VA', 'SC', 'SI', 'SA', 'C', 'I', 'A'].some((k) => has(k, 'L'));
  if (highImpact) return has('AV', 'N') ? 'high' : 'moderate';
  return lowImpact ? 'low' : 'unknown';
}

function severityOf(v: OsvVuln): Advisory['severity'] {
  if (v.id.startsWith('MAL-')) return 'critical';
  const s = v.database_specific?.severity?.toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'low') return s;
  if (s === 'moderate' || s === 'medium') return 'moderate';
  const vector = v.severity?.find((x) => x.type.startsWith('CVSS'))?.score;
  return vector ? cvssSeverity(vector) : 'unknown';
}

/**
 * Advisories for one version. The same issue often appears as several OSV records (GHSA-…, PYSEC-…, CVE-…)
 * linked by aliases; they are merged into one, keeping the GHSA id and the highest severity.
 */
export async function advisories(eco: Ecosystem, name: string, version: string): Promise<Advisory[]> {
  const d = await getJSON<{ vulns?: OsvVuln[] }>('https://api.osv.dev/v1/query', {
    body: { package: { name, ecosystem: ECO[eco] }, version },
  });
  const merged: Advisory[] = [];
  const byAlias = new Map<string, Advisory>();
  for (const v of d.vulns ?? []) {
    if (v.withdrawn) continue; // retracted by its publisher
    const ids = [v.id, ...(v.aliases ?? [])];
    // Malware is reported as MAL-… records, sometimes only as an alias of a GHSA record: any MAL- id counts.
    const malicious = ids.some((id) => id.startsWith('MAL-'));
    const existing = ids.map((id) => byAlias.get(id)).find(Boolean);
    const severity = malicious ? 'critical' : severityOf(v);
    if (existing) {
      if (RANK[severity] > RANK[existing.severity]) existing.severity = severity;
      if (malicious) existing.malicious = true;
      const better = ids.find((x) => x.startsWith('MAL-')) ?? (v.id.startsWith('GHSA-') ? v.id : null);
      if (better && !existing.id.startsWith('MAL-') && (better.startsWith('MAL-') || !existing.id.startsWith('GHSA-'))) existing.id = better;
    } else {
      const a: Advisory = {
        id: ids.find((x) => x.startsWith('MAL-')) ?? ids.find((x) => x.startsWith('GHSA-')) ?? v.id,
        summary: sanitize((v.summary || v.details || '').split('\n')[0]!).slice(0, 140),
        severity,
        malicious,
        url: `https://osv.dev/vulnerability/${v.id}`,
      };
      merged.push(a);
    }
    const target = existing ?? merged[merged.length - 1]!;
    for (const id of ids) byAlias.set(id, target);
  }
  return merged.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

export const isSerious = (a: Advisory) => a.malicious || a.severity === 'critical' || a.severity === 'high';
