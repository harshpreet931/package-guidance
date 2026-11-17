#!/usr/bin/env node
// Run the with-vs-without benchmark: prompt × arm × agent × seed, each in a fresh temp repo.
//
//   node evals/run.mjs --dry-run                                 # plan + cost estimate, runs nothing
//   node evals/run.mjs --agents claude --prompts 5 --seeds 1     # small pilot
//
// See evals/README.md for every flag.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, list, readJSON, writeJSON, pool, walk, SKIP_DIRS } from './lib/util.mjs';
import { copySnapshot } from './lib/manifests.mjs';
import { ADAPTERS, GUARD_ENV } from './lib/agents.mjs';
import { waitForQuota, usageSnapshot } from './lib/usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ARMS = ['baseline', 'guided', 'guided-hook'];

const HELP = `usage: node evals/run.mjs [flags]
  --agents claude[,codex,cursor]    adapters to run (codex/cursor are stubs; need --allow-stub)
  --arms baseline,guided            arms: baseline | guided | guided-hook (guided + PreToolUse hook)
  --prompts all|N|id1,id2|npm|pypi  which prompts (N = first N in prompts.json; first 5 are the pilot mix)
  --seeds 1                         repetitions per prompt×arm×agent (count, or explicit list "1,2,3")
  --concurrency 2                   parallel agent sessions
  --timeout 20                      minutes per agent session
  --model <id>                      model passed to the agent CLI (record it! see README)
  --max-budget-usd <n>              per-session spend cap (claude, if supported)
  --run-id <id>                     results/<run-id>/ (default: timestamp). Re-using an id resumes.
  --hook-cmd "<cmd>"                command for the guided-hook arm (default: local CLI or npx)
  --keep-workspace                  also save the final source tree (minus node_modules) for score --build
  --build-check                     run install+build in the temp repo after the agent, save build.json
  --skill <dir>                     skill to install (default: ../skills/package-guidance)
  --cost-per-run <usd>              override the dry-run cost assumption
  --calibrate <runDir>              take dry-run cost/time assumptions from a previous run's meta.json files
  --force                           re-run results that already completed
  --allow-stub                      allow stub adapters (codex, cursor)
  --dry-run                         print the plan and cost estimate, run nothing`;

const args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'keep-workspace', 'build-check', 'force', 'allow-stub', 'help'] });
if (args.help) { console.log(HELP); process.exit(0); }

const agents = list(args.agents, ['claude']);
const arms = list(args.arms, ['baseline', 'guided']);
for (const a of agents) if (!ADAPTERS[a]) die(`unknown agent "${a}" (known: ${Object.keys(ADAPTERS).join(', ')})`);
for (const a of arms) if (!ARMS.includes(a)) die(`unknown arm "${a}" (known: ${ARMS.join(', ')})`);

const P = readJSON(path.join(HERE, 'prompts.json'));
const prompts = selectPrompts(P.prompts, args.prompts ?? 'all');
const seeds = /,/.test(String(args.seeds ?? '')) ? list(args.seeds).map(Number) : Array.from({ length: Number(args.seeds ?? 1) }, (_, i) => i + 1);
const concurrency = Number(args.concurrency ?? 2);
const timeoutMin = Number(args.timeout ?? 20);
const runId = args.runId || new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d\dZ$/, 'Z');
const resultsRoot = path.join(HERE, 'results', runId);
const skillSrc = path.resolve(args.skill || path.join(REPO, 'skills', 'package-guidance'));

// Jobs: prompt×seed outer, agent, then arms; arm order alternates by seed so neither arm always runs first.
const jobs = [];
for (const p of prompts) for (const seed of seeds) for (const agent of agents) {
  const order = seed % 2 ? arms : [...arms].reverse();
  for (const arm of order) jobs.push({ prompt: p, seed, agent, arm, dir: path.join(resultsRoot, agent, arm, p.id, `seed-${seed}`) });
}

// ---------- preflight ----------
const warnings = [];
for (const a of agents) {
  if (ADAPTERS[a].stub && !args.allowStub) warnings.push(`${a}: stub adapter — pass --allow-stub to run it`);
  if (!ADAPTERS[a].available()) warnings.push(`${a}: binary "${ADAPTERS[a].bin}" not found on PATH`);
}
const needsSkill = arms.some((a) => a !== 'baseline');
if (needsSkill && !fs.existsSync(path.join(skillSrc, 'SKILL.md'))) warnings.push(`skill not found: ${skillSrc}/SKILL.md (guided arms cannot run)`);
for (const p of prompts) if (p.fixture && !fs.existsSync(path.join(HERE, 'fixtures', p.fixture))) warnings.push(`prompt ${p.id}: missing fixture ${p.fixture}`);
const hook = arms.includes('guided-hook') ? hookConfig() : null;
if (hook && agents.some((a) => a !== 'claude')) warnings.push('guided-hook installs a Claude Code PreToolUse hook; for other agents it behaves like guided');

if (args.dryRun) { printPlan(); process.exit(0); }
if (warnings.some((w) => /not found|stub adapter|missing fixture/.test(w))) die('preflight failed:\n  ' + warnings.join('\n  '));

writeJSON(path.join(resultsRoot, 'run.json'), {
  runId, createdAt: new Date().toISOString(), agents, arms, seeds, prompts: prompts.map((p) => p.id), model: args.model || null,
  timeoutMin, concurrency, skill: path.relative(REPO, skillSrc), skillHash: hashDir(needsSkill ? skillSrc : null), hook: hook ? hook.description : null,
  host: { platform: process.platform, node: process.version, agentVersions: Object.fromEntries(agents.map((a) => [a, version(ADAPTERS[a].bin)])) },
});

let done = 0;
const t0 = Date.now();
await pool(jobs, concurrency, async (job) => {
  const r = await runJob(job);
  done++;
  const eta = ((Date.now() - t0) / done) * (jobs.length - done) / 60000;
  console.log(`[${done}/${jobs.length}] ${job.agent}/${job.arm}/${job.prompt.id}/seed-${job.seed}: ${r.status}${r.costUsd != null ? ` $${r.costUsd.toFixed(2)}` : ''} (${(r.durationMs / 60000 || 0).toFixed(1)}m) · ETA ${eta.toFixed(0)}m`);
});
console.log(`\ndone → ${path.relative(process.cwd(), resultsRoot)}\nnext: node evals/score.mjs ${path.relative(process.cwd(), resultsRoot)} && node evals/report.mjs ${path.relative(process.cwd(), resultsRoot)}`);

// ---------- job ----------
async function runJob(job) {
  const { prompt: p, agent, arm, seed, dir } = job;
  const prev = readJSON(path.join(dir, 'meta.json'), null);
  if (prev && prev.status === 'ok' && !args.force) return { ...prev, status: 'skipped (done)' };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const A = ADAPTERS[agent];
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-eval-')));
  const work = path.join(tmp, 'repo');
  const meta = { runId, agent, arm, promptId: p.id, ecosystem: p.ecosystem, kind: p.kind, fixture: p.fixture, seed, model: args.model || null, startedAt: null };
  try {
    if (p.fixture) fs.cpSync(path.join(HERE, 'fixtures', p.fixture), work, { recursive: true });
    else { fs.mkdirSync(work); fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n.venv/\n__pycache__/\ndist/\n'); }
    git(work, ['init', '-q']);
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.email=eval@example.invalid', '-c', 'user.name=eval', 'commit', '-q', '-m', 'fixture', '--allow-empty']);
    fs.mkdirSync(path.join(dir, 'snapshot-before'), { recursive: true });
    copySnapshot(work, path.join(dir, 'snapshot-before'));
    if (arm !== 'baseline') A.installGuidance(work, { skillSrc, hook: arm === 'guided-hook' ? hook.hooks : null });

    const text = `${p.prompt}\n\n${P.preamble}`;
    fs.writeFileSync(path.join(dir, 'prompt.txt'), text + '\n');
    // Respect the operator's Claude subscription: pause below PG_USAGE_MAX (default 80%) until the window resets.
    if (agent === 'claude') {
      await waitForQuota((m) => console.log(m));
      meta.usageAtStart = await usageSnapshot();
    }
    const { cmd, args: cargs, transcriptFile } = A.command(text, { model: args.model, maxBudgetUsd: args.maxBudgetUsd });
    meta.command = [cmd, ...cargs.map((a) => (a === text ? '<prompt.txt>' : a))].join(' ');
    meta.startedAt = new Date().toISOString();
    const res = await exec(cmd, cargs, { cwd: work, timeoutMs: timeoutMin * 60000, stdoutFile: path.join(dir, transcriptFile), stderrFile: path.join(dir, 'stderr.log') });
    meta.finishedAt = new Date().toISOString();
    meta.durationMs = Date.parse(meta.finishedAt) - Date.parse(meta.startedAt);
    meta.exitCode = res.code;
    const parsed = A.parse(fs.readFileSync(path.join(dir, transcriptFile), 'utf8'));
    Object.assign(meta, { costUsd: parsed.costUsd ?? null, sessionId: parsed.sessionId ?? null, turns: parsed.turns ?? null, modelsUsed: parsed.model ?? null });
    meta.status = res.timedOut ? 'timeout' : res.code === 0 && parsed.ok ? 'ok' : 'error';
    meta.sessionCollected = A.collectSession(parsed.sessionId, dir);

    // final repo snapshot (manifests + lockfiles only) and a change summary
    copySnapshot(work, path.join(dir, 'snapshot'));
    const status = git(work, ['status', '--porcelain', '--untracked-files=all']);
    fs.writeFileSync(path.join(dir, 'changes.txt'), status.split('\n').filter((l) => !/\.claude\/skills|\.agents\/skills|\.codex\/skills|\.cursor\//.test(l)).join('\n') + '\n');
    if (args.buildCheck) writeJSON(path.join(dir, 'build.json'), buildCheck(work));
    if (args.keepWorkspace) saveWorkspace(work, path.join(dir, 'workspace'));
  } catch (e) {
    meta.status = 'error';
    meta.error = String(e.stack || e);
    if (!meta.startedAt) meta.startedAt = new Date().toISOString();
  } finally {
    writeJSON(path.join(dir, 'meta.json'), meta);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return meta;
}

function exec(cmd, cargs, { cwd, timeoutMs, stdoutFile, stderrFile }) {
  return new Promise((resolve) => {
    const out = fs.openSync(stdoutFile, 'w'), err = fs.openSync(stderrFile, 'w');
    const child = spawn(cmd, cargs, { cwd, stdio: ['ignore', out, err], detached: true, env: { ...process.env, ...(process.env.PG_EVAL_UNGUARDED === '1' ? {} : GUARD_ENV), CI: '1', npm_config_yes: 'true', PG_EVAL: '1' } });
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); fs.writeSync(err, String(e)); fs.closeSync(out); fs.closeSync(err); resolve({ code: -1, timedOut }); });
    child.on('exit', (code) => { clearTimeout(t); fs.closeSync(out); fs.closeSync(err); resolve({ code, timedOut }); });
  });
}

function git(cwd, a) { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); return r.stdout || ''; }
function version(bin) { const r = spawnSync(bin, ['--version'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim().split('\n')[0] : null; }

function buildCheck(work) {
  const run = (cmd, a) => { const r = spawnSync(cmd, a, { cwd: work, timeout: 10 * 60000, encoding: 'utf8', env: { ...process.env, CI: '1' } }); return { cmd: [cmd, ...a].join(' '), code: r.status, tail: ((r.stdout || '') + (r.stderr || '')).slice(-2000) }; };
  const steps = [];
  if (fs.existsSync(path.join(work, 'package.json'))) {
    if (!fs.existsSync(path.join(work, 'node_modules'))) steps.push(run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']));
    if (steps.every((s) => s.code === 0)) steps.push(run('npm', ['run', 'build', '--if-present']));
  }
  if ([...walk(work, { maxDepth: 4 })].some((f) => f.endsWith('.py'))) steps.push(run('python3', ['-m', 'compileall', '-q', '-x', '(node_modules|\\.venv)', '.']));
  return { ok: steps.length ? (steps.every((s) => s.code === 0) ? 1 : 0) : null, steps };
}

function saveWorkspace(src, dst) {
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !SKIP_DIRS.has(path.basename(s)) || s === src });
}

function hookConfig() {
  const pluginHooks = path.join(REPO, 'hooks', 'hooks.json');
  if (!args.hookCmd && fs.existsSync(pluginHooks)) {
    const raw = fs.readFileSync(pluginHooks, 'utf8').replaceAll('${CLAUDE_PLUGIN_ROOT}', REPO);
    const j = JSON.parse(raw);
    return { hooks: j.hooks || j, description: `hooks/hooks.json (plugin root = ${REPO})` };
  }
  const local = ['bin/package-guidance.js', 'bin/package-guidance.mjs', 'dist/cli.js'].map((f) => path.join(REPO, f)).find((f) => fs.existsSync(f));
  const cmd = args.hookCmd || (local ? `node ${JSON.stringify(local)} hook` : 'npx -y package-guidance@latest hook');
  return { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd, timeout: 60 }] }] }, description: cmd };
}

function hashDir(d) {
  if (!d || !fs.existsSync(d)) return null;
  const h = spawnSync('sh', ['-c', `cd ${JSON.stringify(d)} && find . -type f | sort | xargs shasum | shasum`], { encoding: 'utf8' });
  return h.stdout.trim().split(/\s+/)[0] || null;
}

function selectPrompts(all, sel) {
  sel = String(sel);
  if (sel === 'all') return all;
  if (/^\d+$/.test(sel)) return all.slice(0, Number(sel));
  if (sel === 'npm' || sel === 'pypi') return all.filter((p) => p.ecosystem === sel);
  const ids = list(sel);
  const out = ids.map((id) => all.find((p) => p.id === id) || die(`unknown prompt id "${id}"`));
  return out;
}

function printPlan() {
  const cal = args.calibrate ? calibrate(path.resolve(args.calibrate)) : null;
  console.log(`package-guidance eval — DRY RUN (nothing will be executed)\n`);
  console.log(`run id       ${runId}  →  ${path.relative(process.cwd(), resultsRoot)}`);
  console.log(`agents       ${agents.join(', ')}${args.model ? `  (model ${args.model})` : ''}`);
  console.log(`arms         ${arms.join(', ')}`);
  console.log(`prompts      ${prompts.length} (${prompts.filter((p) => p.ecosystem === 'npm').length} npm, ${prompts.filter((p) => p.ecosystem === 'pypi').length} PyPI; ${prompts.filter((p) => p.fixture).length} start from fixtures)`);
  console.log(`seeds        ${seeds.join(', ')}`);
  console.log(`sessions     ${jobs.length} = ${prompts.length} prompts × ${arms.length} arms × ${agents.length} agents × ${seeds.length} seeds`);
  console.log(`concurrency  ${concurrency} · timeout ${timeoutMin}m per session`);
  if (hook) console.log(`hook         ${hook.description}`);
  console.log(`skill        ${path.relative(process.cwd(), skillSrc)}${fs.existsSync(path.join(skillSrc, 'SKILL.md')) ? '' : '  (MISSING)'}`);
  console.log('');
  let lo = 0, mid = 0, hi = 0, minutes = 0;
  const rows = [];
  for (const a of agents) for (const arm of arms) {
    const n = jobs.filter((j) => j.agent === a && j.arm === arm).length;
    const est = ADAPTERS[a].estimate;
    const mult = arm === 'baseline' ? 1 : 1.15; // guided reads SKILL.md + runs checks
    const c = cal?.[`${a}/${arm}`];
    const usd = args.costPerRun ? Number(args.costPerRun) : c?.usd ?? est.usd * mult;
    const min = c?.minutes ?? est.minutes * mult;
    lo += n * (c ? usd * 0.7 : est.low * mult); mid += n * usd; hi += n * (c ? usd * 1.5 : est.high * mult); minutes += n * min;
    rows.push(`  ${`${a}/${arm}`.padEnd(22)} ${String(n).padStart(4)} sessions × ~$${usd.toFixed(2)}${c ? ' (calibrated)' : ''} ≈ $${(n * usd).toFixed(2)}`);
  }
  console.log('cost estimate (API-equivalent; on a subscription plan this is usage quota, not dollars)');
  console.log(rows.join('\n'));
  console.log(`  ${'total'.padEnd(22)} ≈ $${mid.toFixed(0)}  (range $${lo.toFixed(0)}–$${hi.toFixed(0)})`);
  console.log(`wall time    ≈ ${(minutes / concurrency / 60).toFixed(1)} h at concurrency ${concurrency} (≈ ${(minutes / jobs.length || 0).toFixed(1)} min/session)`);
  console.log(`scoring      free (public npm / PyPI / OSV APIs), ~1–3 min`);
  console.log('');
  console.log('first sessions:');
  for (const j of jobs.slice(0, 8)) console.log(`  ${j.agent}/${j.arm}/${j.prompt.id}/seed-${j.seed}${j.prompt.fixture ? `  [fixture ${j.prompt.fixture}]` : ''}`);
  if (jobs.length > 8) console.log(`  … ${jobs.length - 8} more`);
  if (agents.includes('claude')) {
    const sample = ADAPTERS.claude.available() ? ADAPTERS.claude.command('<prompt>', { model: args.model, maxBudgetUsd: args.maxBudgetUsd }) : null;
    if (sample) console.log(`\ncommand      cd <tmp>/repo && ${sample.cmd} ${sample.args.join(' ')}`);
  }
  if (warnings.length) console.log('\nwarnings:\n  ' + warnings.join('\n  '));
}

function calibrate(dir) {
  const acc = {};
  for (const rel of walk(dir, { maxDepth: 5, skip: new Set(['snapshot', 'snapshot-before', 'workspace']) })) {
    if (path.basename(rel) !== 'meta.json') continue;
    const m = readJSON(path.join(dir, rel), null);
    if (!m || m.costUsd == null) continue;
    const k = `${m.agent}/${m.arm}`;
    acc[k] ??= { usd: 0, min: 0, n: 0 };
    acc[k].usd += m.costUsd; acc[k].min += (m.durationMs || 0) / 60000; acc[k].n++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { usd: v.usd / v.n, minutes: v.min / v.n }]));
}

function die(msg) { console.error(msg); process.exit(1); }
