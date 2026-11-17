#!/usr/bin/env node
// Turn a scored run (summary.json + per-result score.json) into report.md and chart-data.json.
// usage: node evals/report.mjs <scoredRunDir> [--title "..."]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJSON, writeJSON } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2), { booleans: ['help'] });
if (args.help || !args._[0]) { console.log('usage: node evals/report.mjs <scoredRunDir> [--title "..."]'); process.exit(args.help ? 0 : 1); }
const dir = path.resolve(args._[0]);
const S = readJSON(path.join(dir, 'summary.json'));
const runMeta = readJSON(path.join(S.runDir, 'run.json'), {});
const M = Object.fromEntries(S.metricsCatalogue.map((m) => [m.key, m]));
const HEADLINE = S.metricsCatalogue.filter((m) => m.headline).map((m) => m.key);
const SECONDARY = ['highCrit', 'advisories', 'issueRate', 'e18e', 'youngPkg', 'exactPinRate', 'hasLockfile', 'buildOk', 'deps'];
const HEALTH = ['agentOk', 'skillTriggered', 'costUsd', 'durationMin'];

const isRate = (k) => !!M[k]?.rate;
const num = (x, k, signed = false) => {
  if (x === null || x === undefined) return 'n/a';
  const v = isRate(k) ? x * 100 : x;
  const s = isRate(k) ? `${v.toFixed(0)}${signed ? ' pp' : '%'}` : k === 'costUsd' ? `$${v.toFixed(2)}` : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return signed && v > 0 ? `+${s}` : s;
};
const ci = (c, k, signed = true) => (c ? `[${num(c[0], k, signed)}, ${num(c[1], k, signed)}]` : 'n/a');
const rel = (r) => (r === null || r === undefined ? '' : `${r > 0 ? '+' : ''}${(r * 100).toFixed(0)}%`);
const verdict = (d, k) => {
  if (!d.ci || M[k].neutral) return '';
  const better = M[k].better === 'higher' ? d.ci[0] > 0 : d.ci[1] < 0;
  const worse = M[k].better === 'higher' ? d.ci[1] < 0 : d.ci[0] > 0;
  return better ? 'better' : worse ? 'worse' : 'n.s.';
};

const L = [];
const title = args.title || `package-guidance uplift eval — ${path.basename(S.runDir)}`;
L.push(`# ${title}`, '');
L.push(`- Run: \`${path.basename(S.runDir)}\` · agents run ${S.runStartedAt?.slice(0, 10)}${S.runEndedAt && S.runEndedAt.slice(0, 10) !== S.runStartedAt?.slice(0, 10) ? ` → ${S.runEndedAt.slice(0, 10)}` : ''} · scored ${S.scoredAt.slice(0, 16)}Z (registry data fetched ${S.registryFetchedAt?.slice(0, 16) ?? '?'}Z)`);
L.push(`- ${S.results} results · ${S.prompts} prompts · agents: ${S.agents.join(', ')} · arms: ${S.arms.join(', ')} · cooldown ${S.cooldownDays}d${runMeta.model ? ` · model ${runMeta.model}` : ''}`);
if (runMeta.note) L.push(`- Note: ${runMeta.note}`);
L.push(`- Intervals: ${S.bootstrap.interval} bootstrap CI (B=${S.bootstrap.B}, ${S.bootstrap.resampling}). "n.s." = CI crosses 0.`, '');

// A comparison over a handful of prompts has no meaningful interval; list it as incomplete instead.
const MIN_PAIRED = 10;
const allDeltas = Object.values(S.deltas);
const deltas = allDeltas.filter((d) => (d.metrics.issueDeps?.pairedPrompts ?? 0) >= MIN_PAIRED);
const thin = allDeltas.filter((d) => !deltas.includes(d)).map((d) => `${d.agent} + ${d.arm}`);
const unscored = Object.values(S.groups).filter((g) => !g.metrics.issueDeps).map((g) => `${g.agent} + ${g.arm}`);
if (thin.length || unscored.length) L.push(`- Incomplete, not compared (fewer than ${MIN_PAIRED} prompts with a usable run in both arms): ${[...new Set([...thin, ...unscored])].join(', ')}.`, '');
if (deltas.length) {
  L.push('## Headline', '');
  for (const d of deltas) {
    const x = d.metrics.issueDeps, c = d.metrics.clean, h = d.metrics.notFound;
    if (x) L.push(`- **${d.agent} + ${d.arm}** vs baseline: dependency issues per run ${num(x.baseline, 'issueDeps')} → ${num(x.guided, 'issueDeps')} (${rel(x.relative)}, Δ 95% CI ${ci(x.ci, 'issueDeps')}); clean runs ${num(c?.baseline, 'clean')} → ${num(c?.guided, 'clean')}; hallucinated packages ${num(h?.baseline, 'notFound')} → ${num(h?.guided, 'notFound')} per run${d.touched.issueDeps ? `; counting only deps the agent added or changed: ${num(d.touched.issueDeps.baseline, 'issueDeps')} → ${num(d.touched.issueDeps.guided, 'issueDeps')} (Δ 95% CI ${ci(d.touched.issueDeps.ci, 'issueDeps')})` : ''}.`);
  }
  L.push('');
  for (const d of deltas) {
    for (const [scope, keys, heading] of [['metrics', HEADLINE, 'Final repo state (all direct deps)'], ['metrics', SECONDARY, 'Secondary metrics'], ['touched', HEADLINE, 'Only deps the agent added or changed'], ['metrics', HEALTH, 'Agent health & manipulation check']]) {
      const rows = keys.filter((k) => d[scope][k]);
      if (!rows.length) continue;
      L.push(`### ${d.agent}: ${d.arm} vs baseline — ${heading}`, '');
      L.push('| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |', '|---|---:|---:|---:|---:|---:|---|');
      for (const k of rows) {
        const x = d[scope][k];
        L.push(`| ${M[k].label} <sub>${M[k].unit}</sub> | ${num(x.baseline, k)} (${num(x.medianBaseline, k)}) | ${num(x.guided, k)} (${num(x.medianGuided, k)}) | ${num(x.delta, k, true)} | ${ci(x.ci, k)} | ${isRate(k) ? '' : rel(x.relative)} | ${verdict(x, k)} |`);
      }
      L.push(`\n<sub>Paired prompts: ${d[scope][rows[0]].pairedPrompts}</sub>`, '');
    }
  }
}

L.push('## Per group', '');
L.push('| Group | n | Issues/run (mean, 95% CI) | Median | Clean runs | Hallucinated/run | Fresh/run | Vulnerable/run |', '|---|---:|---:|---:|---:|---:|---:|---:|');
for (const g of Object.values(S.groups)) {
  const m = g.metrics;
  L.push(`| ${g.agent}/${g.arm} | ${g.n} | ${num(m.issueDeps?.mean, 'issueDeps')} ${ci(m.issueDeps?.ciMean, 'issueDeps', false)} | ${num(m.issueDeps?.median, 'issueDeps')} | ${num(m.clean?.mean, 'clean')} | ${num(m.notFound?.mean, 'notFound')} | ${num(m.fresh?.mean, 'fresh')} | ${num(m.vulnerable?.mean, 'vulnerable')} |`);
}
L.push('');

const cols = [...new Set(S.perPrompt.flatMap((r) => Object.keys(r).filter((k) => k !== 'promptId')))].sort();
if (cols.length) {
  L.push('## Per prompt (mean dependency issues per run)', '');
  L.push(`| Prompt | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---:').join('|')}|`);
  for (const r of S.perPrompt) L.push(`| ${r.promptId} | ${cols.map((c) => (r[c] === undefined ? '—' : r[c])).join(' | ')} |`);
  L.push('');
}

L.push('## What the agents picked (most frequent offenders)', '');
const FLAG_LABEL = { notFound: 'Hallucinated (404)', deprecated: 'Deprecated', outdated: 'Behind current major', fresh: 'Fresh (<cooldown) version', vulnerable: 'Known advisory' };
for (const [group, flags] of Object.entries(S.offenders)) {
  L.push(`**${group}**`, '');
  for (const f of Object.keys(FLAG_LABEL)) {
    const top = Object.entries(flags[f] || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) L.push(`- ${FLAG_LABEL[f]}: ${top.map(([k, n]) => `\`${k}\`${n > 1 ? ` ×${n}` : ''}`).join(', ')}`);
  }
  L.push('');
}

L.push('## Method (short)', '');
L.push('Each prompt runs in a fresh temp copy of its fixture, once per arm (baseline = no skill; guided = `skills/package-guidance` copied into `.claude/skills/`). The final manifests and lockfiles are scored against public data only — npm registry / PyPI JSON (existence, `deprecated`/yanked, current major, publish times) and OSV.dev `querybatch` — never with package-guidance itself. "Behind the current major" compares against the latest stable release that was already ≥ cooldown days old at run time, so an agent is not penalised for honouring the cooldown. Fresh-version exposure counts direct deps resolved to a version published < cooldown days before the run started. Without a lockfile, OSV is queried at the range minimum and other checks use the highest version the range would have resolved to at run time. See `evals/README.md` for threats to validity.', '');

fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n') + '\n');

// ---- chart-data.json for the landing site ----
const chart = {
  schema: 'package-guidance-evals/chart-data@1',
  runId: path.basename(S.runDir), runDate: S.runStartedAt?.slice(0, 10), scoredAt: S.scoredAt, cooldownDays: S.cooldownDays,
  results: S.results, prompts: S.prompts,
  comparisons: deltas.map((d) => ({
    agent: d.agent, arm: d.arm, vs: 'baseline',
    metrics: HEADLINE.filter((k) => d.metrics[k]).map((k) => {
      const x = d.metrics[k];
      return { key: k, label: M[k].label, unit: M[k].unit, better: M[k].better || 'lower', isRate: isRate(k), baseline: x.baseline, guided: x.guided, delta: x.delta, relative: x.relative, ci95: x.ci, significant: verdict(x, k) === 'better' || verdict(x, k) === 'worse' };
    }),
  })),
};
writeJSON(path.join(dir, 'chart-data.json'), chart);
console.log(`wrote ${path.join(dir, 'report.md')}\nwrote ${path.join(dir, 'chart-data.json')}`);
