#!/usr/bin/env node
// Score every result directory of an eval run against PUBLIC data only:
// npm registry, PyPI JSON API, OSV.dev (and, as a secondary metric, e18e module-replacements).
// It never calls package-guidance's CLI or reads its curated data — we don't grade ourselves.
//
// usage: node evals/score.mjs <runDir> [--out <dir>] [--cooldown 7] [--build] [--registry-snapshot <file>] [--offline] [--concurrency 8]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJSON, writeJSON, readText, walk, mean, median, bootstrapCI, bootstrapDeltaCI, round, DAY } from './lib/util.mjs';
import { extractDeps } from './lib/manifests.mjs';
import { eco, pickVersion } from './lib/versions.mjs';
import { PublicData } from './lib/registry.mjs';

// Metric catalogue. `headline` metrics are the launch numbers; all are "lower is better" unless better: 'higher'.
export const METRICS = [
  { key: 'issueDeps', label: 'Direct deps with any issue', unit: 'deps/run', headline: true },
  { key: 'clean', label: 'Runs with zero dependency issues', unit: '% of runs', better: 'higher', rate: true, headline: true },
  { key: 'notFound', label: 'Hallucinated packages (registry 404)', unit: 'deps/run', headline: true },
  { key: 'deprecated', label: 'Deprecated deps (registry flag / yanked / inactive)', unit: 'deps/run', headline: true },
  { key: 'outdated', label: 'Deps behind the current major', unit: 'deps/run', headline: true },
  { key: 'fresh', label: 'Fresh-version exposure (<7d old at run time)', unit: 'deps/run', headline: true },
  { key: 'vulnerable', label: 'Deps with a known advisory (OSV)', unit: 'deps/run', headline: true },
  { key: 'highCrit', label: 'Deps with a high/critical advisory', unit: 'deps/run' },
  { key: 'advisories', label: 'Unique advisories', unit: 'advisories/run' },
  { key: 'issueRate', label: 'Share of direct deps with any issue', unit: '% of deps', rate: true },
  { key: 'deps', label: 'Direct deps (count)', unit: 'deps/run', neutral: true },
  { key: 'e18e', label: 'Deps listed in e18e module-replacements (secondary)', unit: 'deps/run' },
  { key: 'youngPkg', label: 'Packages created <30d before run (slopsquat risk, secondary)', unit: 'deps/run' },
  { key: 'exactPinRate', label: 'Direct deps pinned exactly', unit: '% of deps', better: 'higher', rate: true },
  { key: 'hasLockfile', label: 'Runs that left a lockfile', unit: '% of runs', better: 'higher', rate: true },
  { key: 'buildOk', label: 'Project still builds (--build)', unit: '% of runs', better: 'higher', rate: true },
  { key: 'agentOk', label: 'Agent finished without error/timeout', unit: '% of runs', better: 'higher', rate: true },
  { key: 'skillTriggered', label: 'package-guidance used in transcript (manipulation check)', unit: '% of runs', neutral: true, rate: true },
  { key: 'costUsd', label: 'Agent cost', unit: 'USD/run', neutral: true },
  { key: 'durationMin', label: 'Agent wall time', unit: 'min/run', neutral: true },
];

export function findResults(runDir) {
  const out = [];
  for (const rel of walk(runDir, { maxDepth: 5, skip: new Set(['snapshot', 'snapshot-before', 'workspace', 'node_modules', '.git']) })) {
    if (path.basename(rel) === 'meta.json') out.push(path.join(runDir, path.dirname(rel)));
  }
  return out.sort();
}

/** Latest stable version as of `atMs` (dist-tags.latest if it existed then, else highest stable <= latest's major). */
function latestAt(ecosystem, rec, atMs) {
  const E = eco[ecosystem];
  const lt = rec.versions[rec.latest]?.t;
  if (rec.latest && lt && lt <= atMs) return rec.latest;
  const capMajor = rec.latest ? E.major(rec.latest) : Infinity;
  const vs = Object.keys(rec.versions).filter((v) => !E.isPre(v) && rec.versions[v].t && rec.versions[v].t <= atMs && (E.major(v) ?? 0) <= capMajor).sort(E.cmp);
  return vs[vs.length - 1] || null;
}

function evalDep(dep, rec, runTs, cooldownDays, e18e) {
  const E = eco[dep.ecosystem];
  const r = { ecosystem: dep.ecosystem, name: dep.name, spec: dep.spec, dev: dep.dev, manifest: dep.manifest, flags: [] };
  if (dep.nonRegistry) { r.status = 'non-registry'; return r; }
  if (!rec || rec.status === 'error') { r.status = 'error'; r.error = rec?.error; return r; }
  if (rec.status === 'not-found') { r.status = 'not-found'; r.flags.push('notFound'); return r; }
  r.status = 'ok';
  const versions = Object.keys(rec.versions);
  const times = Object.fromEntries(versions.map((v) => [v, rec.versions[v].t ?? 0]));
  const spec = String(dep.spec || '').trim();
  const pinned = E.exact(spec) ? spec.replace(/^={1,3}\s*/, '') : null;
  const specValid = spec === '' || spec === '*' || spec === 'latest' || E.valid(spec);

  // effective = what this repo installs; osvVersion = what we query OSV with
  if (dep.lockVersion && rec.versions[dep.lockVersion]) { r.effective = dep.lockVersion; r.resolvedFrom = 'lockfile'; }
  else if (pinned && rec.versions[pinned]) { r.effective = pinned; r.resolvedFrom = 'exact-pin'; }
  else if (specValid) {
    r.effective = spec === '' || spec === '*' || spec === 'latest' ? latestAt(dep.ecosystem, rec, runTs) : pickVersion(dep.ecosystem, versions, times, spec, { highest: true, atMs: runTs });
    r.resolvedFrom = 'range-max-at-run';
  }
  if (!r.effective && dep.lockVersion) { r.effective = dep.lockVersion; r.resolvedFrom = 'lockfile-unknown-version'; r.flags.push('lockVersionNotOnRegistry'); }
  // Advisories are checked on the version that gets installed: the lockfile or exact pin, else the highest
  // match at run time (what `npm install` / `pip install` would have resolved). Checking the lowest version a
  // range permits would flag `npm install zod` for advisories in zod@1.0.0, which nobody installs.
  r.osvVersion = r.effective;
  if (!r.effective) { r.flags.push('unresolvable'); return r; }

  const cooldownAgo = runTs - cooldownDays * DAY;
  const settledLatest = latestAt(dep.ecosystem, rec, cooldownAgo) || latestAt(dep.ecosystem, rec, runTs);
  const latestNow = latestAt(dep.ecosystem, rec, runTs);
  r.latestAtRun = latestNow;
  r.settledLatestAtRun = settledLatest;
  const em = E.major(r.effective), sm = settledLatest ? E.major(settledLatest) : null;
  if (em !== null && sm !== null && em < sm) { r.flags.push('outdated'); r.majorsBehind = sm - em; }

  const vEntry = rec.versions[r.effective] || {};
  const latestEntry = (latestNow && rec.versions[latestNow]) || {};
  if (vEntry.d) { r.flags.push('deprecated'); r.deprecatedReason = vEntry.d; }
  else if (latestEntry.d && dep.ecosystem === 'npm') { r.flags.push('deprecated'); r.deprecatedReason = `package deprecated: ${latestEntry.d}`; }
  else if (rec.inactive) { r.flags.push('deprecated'); r.deprecatedReason = 'PyPI classifier: Development Status :: 7 - Inactive'; }

  if (vEntry.t) {
    r.ageDaysAtRun = round((runTs - vEntry.t) / DAY, 2);
    if (r.ageDaysAtRun < cooldownDays) r.flags.push('fresh');
  }
  if (rec.created && runTs - rec.created < 30 * DAY) r.flags.push('youngPkg');
  if (dep.ecosystem === 'npm' && e18e.has(dep.name)) { r.flags.push('e18e'); r.e18e = e18e.get(dep.name); }
  r.exactPinned = !!pinned;
  return r;
}

const CORE = ['notFound', 'deprecated', 'outdated', 'fresh', 'vulnerable'];

function aggregateDeps(deps) {
  const n = deps.filter((d) => d.status !== 'non-registry').length;
  const count = (f) => deps.filter((d) => d.flags.includes(f)).length;
  const issueDeps = deps.filter((d) => d.flags.some((f) => CORE.includes(f))).length;
  const advIds = new Set();
  for (const d of deps) for (const a of d.advisories || []) advIds.add(a.id);
  return {
    deps: n,
    outdated: count('outdated'), deprecated: count('deprecated'), notFound: count('notFound'), fresh: count('fresh'),
    vulnerable: count('vulnerable'), highCrit: count('highCrit'), advisories: advIds.size,
    issueDeps, issueRate: n ? issueDeps / n : null, clean: issueDeps === 0 ? 1 : 0,
    e18e: count('e18e'), youngPkg: count('youngPkg'),
    exactPinRate: n ? deps.filter((d) => d.exactPinned).length / n : null,
    errors: deps.filter((d) => d.status === 'error').length,
  };
}

function skillSignal(dir) {
  const text = [readText(path.join(dir, 'session.jsonl')), readText(path.join(dir, 'transcript.json')), readText(path.join(dir, 'transcript.jsonl'))].filter(Boolean).join('\n');
  if (!text) return null;
  // tool_use blocks mentioning the skill or the CLI; assistant prose alone does not count
  const lines = text.split('\n').filter((l) => /tool_use|"Skill"|"command"/.test(l));
  return lines.some((l) => /package-guidance/.test(l)) ? 1 : 0;
}

function buildCheck(dir) {
  const ws = path.join(dir, 'workspace');
  if (!fs.existsSync(ws)) {
    const b = readJSON(path.join(dir, 'build.json'), null);
    return b ? b.ok : null;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-eval-build-'));
  try {
    fs.cpSync(ws, tmp, { recursive: true });
    const run = (cmd, args) => spawnSync(cmd, args, { cwd: tmp, timeout: 10 * 60 * 1000, stdio: 'ignore', env: { ...process.env, CI: '1' } }).status === 0;
    let ok = true;
    if (fs.existsSync(path.join(tmp, 'package.json'))) {
      const hasLock = fs.existsSync(path.join(tmp, 'package-lock.json'));
      ok = run('npm', [hasLock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund']) && run('npm', ['run', 'build', '--if-present']);
    }
    const hasPy = [...walk(tmp, { maxDepth: 4 })].some((f) => f.endsWith('.py'));
    if (ok && hasPy) ok = run('python3', ['-m', 'compileall', '-q', '.']);
    return ok ? 1 : 0;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export async function scoreRun(runDir, opts = {}) {
  const outDir = opts.out || runDir;
  const cooldown = Number(opts.cooldown ?? 7);
  const data = new PublicData({ snapshotPath: opts.registrySnapshot ? path.resolve(opts.registrySnapshot) : path.join(outDir, 'registry-snapshot.json'), load: !!opts.registrySnapshot, offline: !!opts.offline });
  const resultDirs = findResults(runDir);
  if (!resultDirs.length) throw new Error(`no result dirs (meta.json) under ${runDir}`);

  // 1. extract deps
  const units = resultDirs.map((dir) => {
    const meta = readJSON(path.join(dir, 'meta.json'));
    const snap = path.join(dir, 'snapshot');
    const ex = fs.existsSync(snap) ? extractDeps(snap) : { deps: [], lockfiles: [], manifests: [] };
    const beforeDir = path.join(dir, 'snapshot-before');
    const before = fs.existsSync(beforeDir) ? extractDeps(beforeDir) : null;
    // dedupe by ecosystem+name+spec+lockVersion
    const seen = new Set();
    const deps = ex.deps.filter((d) => { const k = `${d.ecosystem}:${d.name}:${d.spec}:${d.lockVersion}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { dir, meta, ex, deps, before };
  });

  // 2. registry data
  const wanted = new Map();
  for (const u of units) for (const d of u.deps) if (!d.nonRegistry) wanted.set(`${d.ecosystem}:${d.name}`, { ecosystem: d.ecosystem, name: d.name });
  process.stderr.write(`score: ${units.length} results, ${wanted.size} unique packages\n`);
  await data.prefetch([...wanted.values()], Number(opts.concurrency || 8));
  const e18e = await data.e18eMap();

  // 3. per-dep checks
  for (const u of units) {
    const runTs = Date.parse(u.meta.startedAt);
    if (!Number.isFinite(runTs)) throw new Error(`${u.dir}/meta.json: startedAt missing`);
    u.scored = await Promise.all(u.deps.map(async (d) => evalDep(d, await data.pkg(d.ecosystem, d.name), runTs, cooldown, e18e)));
  }

  // 4. OSV
  const queries = [];
  for (const u of units) for (const d of u.scored) if (d.osvVersion) queries.push({ ecosystem: d.ecosystem, name: d.name, version: d.osvVersion });
  const adv = await data.advisories(queries);
  for (const u of units) for (const d of u.scored) {
    if (!d.osvVersion) continue;
    const list = adv.get(`${d.ecosystem}:${d.name}@${d.osvVersion}`) || [];
    const seen = new Set(), uniq = [];
    for (const v of list) {
      if ([v.id, ...(v.aliases || [])].some((x) => seen.has(x))) continue;
      [v.id, ...(v.aliases || [])].forEach((x) => seen.add(x));
      uniq.push({ id: v.id, severity: v.severity, summary: v.summary });
    }
    d.advisories = uniq;
    if (uniq.length) d.flags.push('vulnerable');
    if (uniq.some((v) => v.severity === 'HIGH' || v.severity === 'CRITICAL')) d.flags.push('highCrit');
  }

  // 5. per-result metrics
  const scores = [];
  for (const u of units) {
    const beforeKeys = u.before ? new Set(u.before.deps.map((d) => `${d.ecosystem}:${d.name}:${d.spec}`)) : null;
    const touched = beforeKeys ? u.scored.filter((d) => !beforeKeys.has(`${d.ecosystem}:${d.name}:${d.spec}`)) : u.scored;
    // A run that errored produced no answer. Its empty dependency list is missing data, not a clean
    // result, so its dependency metrics are null (excluded from means and CIs); agentOk still counts it.
    const failed = u.meta.status === 'error';
    const m = failed ? nullMetrics(aggregateDeps([])) : aggregateDeps(u.scored);
    m.hasLockfile = failed ? null : u.ex.lockfiles.length ? 1 : 0;
    m.agentOk = u.meta.status === 'ok' ? 1 : 0;
    m.costUsd = u.meta.costUsd ?? null;
    m.durationMin = u.meta.durationMs ? u.meta.durationMs / 60000 : null;
    m.skillTriggered = skillSignal(u.dir);
    m.buildOk = opts.build ? buildCheck(u.dir) : readJSON(path.join(u.dir, 'build.json'), null)?.ok ?? null;
    const rel = path.relative(runDir, u.dir);
    const s = {
      result: rel, agent: u.meta.agent, arm: u.meta.arm, promptId: u.meta.promptId, seed: u.meta.seed, ecosystem: u.meta.ecosystem,
      startedAt: u.meta.startedAt, agentStatus: u.meta.status, cooldownDays: cooldown,
      metrics: roundObj(m), touched: roundObj(failed ? nullMetrics(aggregateDeps([])) : aggregateDeps(touched)),
      lockfiles: u.ex.lockfiles, manifests: u.ex.manifests, deps: u.scored,
    };
    writeJSON(path.join(outDir, rel, 'score.json'), s);
    scores.push(s);
  }
  data.save();
  const summary = summarize(scores, { runDir, cooldown, registryFetchedAt: data.fetchedAt });
  writeJSON(path.join(outDir, 'summary.json'), summary);
  return { scores, summary, outDir };
}

const nullMetrics = (o) => Object.fromEntries(Object.keys(o).map((k) => [k, null]));
const roundObj = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? round(v, 4) : v]));

export function summarize(scores, { runDir, cooldown, registryFetchedAt }) {
  const agents = [...new Set(scores.map((s) => s.agent))].sort();
  const arms = [...new Set(scores.map((s) => s.arm))].sort((a, b) => (a === 'baseline' ? -1 : b === 'baseline' ? 1 : a.localeCompare(b)));
  const prompts = [...new Set(scores.map((s) => s.promptId))].sort();
  const vals = (rows, key, scope = 'metrics') => rows.map((s) => s[scope][key]).filter((v) => v !== null && v !== undefined);
  const byPrompt = (rows, key, scope) => prompts.map((p) => vals(rows.filter((s) => s.promptId === p), key, scope));

  const groups = {};
  for (const agent of agents) for (const arm of arms) {
    const rows = scores.filter((s) => s.agent === agent && s.arm === arm);
    if (!rows.length) continue;
    const g = { agent, arm, n: rows.length, prompts: new Set(rows.map((r) => r.promptId)).size, metrics: {}, touched: {} };
    for (const scope of ['metrics', 'touched']) for (const M of METRICS) {
      const xs = vals(rows, M.key, scope);
      if (!xs.length) continue;
      g[scope][M.key] = {
        n: xs.length, mean: round(mean(xs), 4), median: round(median(xs), 4),
        ciMean: bootstrapCI(byPrompt(rows, M.key, scope), mean)?.map((x) => round(x, 4)) ?? null,
        ciMedian: bootstrapCI(byPrompt(rows, M.key, scope), median)?.map((x) => round(x, 4)) ?? null,
      };
    }
    groups[`${agent}/${arm}`] = g;
  }

  const deltas = {};
  for (const agent of agents) for (const arm of arms.filter((a) => a !== 'baseline')) {
    const A = scores.filter((s) => s.agent === agent && s.arm === 'baseline');
    const G = scores.filter((s) => s.agent === agent && s.arm === arm);
    if (!A.length || !G.length) continue;
    const d = { agent, arm, vs: 'baseline', metrics: {}, touched: {} };
    for (const scope of ['metrics', 'touched']) for (const M of METRICS) {
      const a = vals(A, M.key, scope), b = vals(G, M.key, scope);
      if (!a.length || !b.length) continue;
      const clusters = prompts.map((p) => ({ a: vals(A.filter((s) => s.promptId === p), M.key, scope), b: vals(G.filter((s) => s.promptId === p), M.key, scope) }));
      const dm = mean(b) - mean(a);
      d[scope][M.key] = {
        baseline: round(mean(a), 4), guided: round(mean(b), 4), delta: round(dm, 4),
        relative: mean(a) ? round(dm / mean(a), 4) : null,
        ci: bootstrapDeltaCI(clusters, mean)?.map((x) => round(x, 4)) ?? null,
        medianBaseline: round(median(a), 4), medianGuided: round(median(b), 4),
        pairedPrompts: clusters.filter((c) => c.a.length && c.b.length).length,
      };
    }
    deltas[`${agent}/${arm}`] = d;
  }

  const perPrompt = prompts.map((p) => {
    const row = { promptId: p };
    for (const agent of agents) for (const arm of arms) {
      const xs = vals(scores.filter((s) => s.promptId === p && s.agent === agent && s.arm === arm), 'issueDeps');
      if (xs.length) row[`${agent}/${arm}`] = round(mean(xs), 3);
    }
    return row;
  });

  const offenders = {};
  for (const s of scores) for (const d of s.deps) for (const f of d.flags.filter((x) => CORE.includes(x))) {
    const k = `${s.agent}/${s.arm}`;
    offenders[k] ??= {};
    offenders[k][f] ??= {};
    const label = f === 'notFound' ? `${d.ecosystem}:${d.name}` : `${d.ecosystem}:${d.name}@${(f === 'vulnerable' ? d.osvVersion : d.effective) ?? d.spec}`;
    offenders[k][f][label] = (offenders[k][f][label] || 0) + 1;
  }

  return {
    schema: 'package-guidance-evals/summary@1',
    runDir: path.resolve(runDir), scoredAt: new Date().toISOString(), registryFetchedAt, cooldownDays: cooldown,
    runStartedAt: scores.map((s) => s.startedAt).sort()[0], runEndedAt: scores.map((s) => s.startedAt).sort().at(-1),
    agents, arms, prompts: prompts.length, results: scores.length,
    bootstrap: { B: 2000, resampling: 'prompt clusters', interval: 'percentile 95%' },
    metricsCatalogue: METRICS,
    groups, deltas, perPrompt, offenders,
    results_index: scores.map((s) => ({ result: s.result, agent: s.agent, arm: s.arm, promptId: s.promptId, seed: s.seed, agentStatus: s.agentStatus, ...s.metrics })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ['build', 'offline', 'help'] });
  if (args.help || !args._[0]) {
    console.log('usage: node evals/score.mjs <runDir> [--out <dir>] [--cooldown 7] [--build] [--registry-snapshot <file>] [--offline]');
    process.exit(args.help ? 0 : 1);
  }
  const runDir = path.resolve(args._[0]);
  const out = args.out ? path.resolve(args.out) : runDir;
  const { summary } = await scoreRun(runDir, { ...args, out });
  for (const [k, d] of Object.entries(summary.deltas)) {
    console.log(`\n${k} vs baseline`);
    for (const M of METRICS.filter((m) => m.headline)) {
      const x = d.metrics[M.key];
      if (x) console.log(`  ${M.key.padEnd(11)} baseline ${fmt(x.baseline)}  guided ${fmt(x.guided)}  Δ ${fmt(x.delta)}  95% CI [${x.ci ? x.ci.map(fmt).join(', ') : 'n/a'}]`);
    }
  }
  if (!Object.keys(summary.deltas).length) for (const [k, g] of Object.entries(summary.groups)) console.log(k, JSON.stringify(Object.fromEntries(Object.entries(g.metrics).map(([m, v]) => [m, v.mean]))));
  console.log(`\nwrote ${path.join(out, 'summary.json')}`);
}
function fmt(x) { return x === null || x === undefined ? 'n/a' : (Math.round(x * 100) / 100).toString(); }
