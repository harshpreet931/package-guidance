#!/usr/bin/env node
// Choice eval: which dependencies does a model pick, with and without package-guidance?
//
// Unlike run.mjs (full agent sessions), nothing is executed: each model answers with the install commands it
// would run, through any OpenAI-compatible /chat/completions endpoint (e.g. a local gateway). The commands are
// turned into manifests and graded by the same independent scorer (score.mjs). Safe and cheap enough to run
// across many models.
//
// Arms:
//   baseline  plain prompt, no tools
//   registry  + a generic `registry_lookup` tool (latest version, publish date, deprecation): the fairness control.
//             Does package-guidance beat simply giving the model registry access?
//   guided    + the package-guidance skill as system prompt and a `package_guidance_check` tool (local CLI)
//
// usage: node evals/choice.mjs --models a,b [--base-url http://localhost:3456] [--arms baseline,registry,guided]
//                              [--prompts 10 | --prompts id1,id2] [--seeds 1] [--concurrency 4] [--run-id name] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, list, writeJSON, pool } from './lib/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BIN = path.join(REPO, 'bin', 'package-guidance.js');

const args = parseArgs(process.argv.slice(2), { booleans: ['dry-run', 'reextract'] });
const BASE = String(args['base-url'] || process.env.CHOICE_BASE_URL || 'http://localhost:3456').replace(/\/$/, '');
const MODELS = list(args.models, []);
const ARMS = list(args.arms, ['baseline', 'registry', 'guided']);
const SEEDS = Number(args.seeds || 1);
const CONCURRENCY = Number(args.concurrency || 4);
const MAX_TURNS = 10;
const runId = String(args.runId || args['run-id'] || `choice-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
const runDir = path.join(HERE, 'results', runId);

const allPrompts = JSON.parse(fs.readFileSync(path.join(HERE, 'prompts.json'), 'utf8'));
const promptList = Array.isArray(allPrompts) ? allPrompts : allPrompts.prompts;
const sel = list(args.prompts, []);
const prompts = sel.length === 1 && /^\d+$/.test(sel[0]) ? promptList.slice(0, Number(sel[0])) : sel.length ? promptList.filter((p) => sel.includes(p.id)) : promptList;

// `--reextract --run-id X`: re-parse saved answers into snapshots with the current extractor. No model calls.
if (args.reextract) {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === 'answer.md') {
    fs.rmSync(path.join(d, 'snapshot'), { recursive: true, force: true });
    writeSnapshot(d, extractSpecs(fs.readFileSync(path.join(d, e.name), 'utf8'))); n++;
  } };
  walk(runDir);
  console.log(`re-extracted ${n} answers in ${runId}`);
  process.exit(0);
}

if (!MODELS.length) { console.error('Pass --models id1,id2 (model ids your endpoint serves).'); process.exit(2); }

// ------------------------------------------------------------------ prompt construction

const FIXTURE_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'requirements-dev.txt', '.eslintrc.json', '.eslintrc.js', 'tsconfig.json'];
function fixtureContext(p) {
  if (!p.fixture) return '';
  const dir = path.join(HERE, 'fixtures', p.fixture);
  const parts = [];
  for (const f of FIXTURE_FILES) {
    const file = path.join(dir, f);
    if (fs.existsSync(file)) parts.push(`--- ${f} ---\n${fs.readFileSync(file, 'utf8').trim()}`);
  }
  return parts.length ? `\n\nThe existing project contains:\n\n${parts.join('\n\n')}` : '';
}

const TASK_SUFFIX = `

Today is ${new Date().toISOString().slice(0, 10)}. You cannot run commands yourself. Reply with every shell command you would run to add or change dependencies for this task (installs, upgrades, removals, scaffolders), exactly as you would type them, in a single \`\`\`bash code block. Then one short line per dependency explaining the choice. Do not write package.json or requirements files by hand.`;

function skillPrompt() {
  const raw = fs.readFileSync(path.join(REPO, 'skills', 'package-guidance', 'SKILL.md'), 'utf8');
  const body = raw.replace(/^---[\s\S]*?\n---\n/, '');
  // In this eval the CLI is exposed as a tool rather than a shell command.
  return `${body}\n\n## In this environment\nYou cannot run shell commands. Wherever the procedure says to run \`check\`, call the \`package_guidance_check\` tool instead (it returns the same JSON). Use \`package_guidance_guide\` to read a guide.`;
}

// ------------------------------------------------------------------ tools

const TOOLS = {
  registry: [{
    type: 'function',
    function: {
      name: 'registry_lookup',
      description: 'Look up a package on the npm or PyPI registry: whether it exists, its latest version and publish date, recent versions, and whether it is deprecated.',
      parameters: { type: 'object', properties: { ecosystem: { type: 'string', enum: ['npm', 'pypi'] }, name: { type: 'string' } }, required: ['ecosystem', 'name'] },
    },
  }],
  guided: [
    {
      type: 'function',
      function: {
        name: 'package_guidance_check',
        description: 'Run `package-guidance check` on packages you are about to add. Returns a verdict per package, the pinned version to install, alternatives, guides, and a ready-to-run install command.',
        parameters: {
          type: 'object',
          properties: { ecosystem: { type: 'string', enum: ['npm', 'pypi'] }, packages: { type: 'array', items: { type: 'string' }, description: 'Specs like "react", "tailwindcss@3", "pydantic<2"' } },
          required: ['ecosystem', 'packages'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'package_guidance_guide',
        description: 'Print a package-guidance migration guide by id (e.g. tailwind-v4) or search guides by query.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    },
  ],
};

async function registryLookup({ ecosystem, name }) {
  const sys = ecosystem === 'pypi' ? 'pypi' : 'npm';
  const res = await fetch(`https://api.deps.dev/v3/systems/${sys}/packages/${encodeURIComponent(name)}`);
  if (res.status === 404) return { exists: false };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const d = await res.json();
  const versions = (d.versions || []).filter((v) => v.publishedAt).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const latest = versions.find((v) => v.isDefault) || versions[0];
  return {
    exists: true,
    latest: latest?.versionKey.version,
    latestPublishedAt: latest?.publishedAt,
    deprecated: latest?.isDeprecated ? latest.deprecatedReason || true : false,
    recentVersions: versions.slice(0, 6).map((v) => ({ version: v.versionKey.version, publishedAt: v.publishedAt })),
  };
}

function runCli(cliArgs) {
  const r = spawnSync(process.execPath, [BIN, ...cliArgs], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  return (r.stdout || r.stderr || '').trim();
}

function guidanceCheck({ ecosystem, packages }) {
  const out = runCli(['check', ...(ecosystem === 'pypi' ? ['--pypi'] : ['--npm']), '--json', ...(packages || []).slice(0, 25)]);
  try {
    const j = JSON.parse(out);
    // Same information the skill sees, minus bulky fields.
    return {
      cooldown: j.cooldown, install: j.install, blocked: j.blocked,
      results: j.results.map((r) => ({ name: r.name, requested: r.requested, verdict: r.verdict, severity: r.severity, version: r.version, message: r.message, alternatives: r.alternatives, guide: r.guide, fixedIn: r.fixedIn, notes: r.notes.slice(0, 3) })),
    };
  } catch {
    return { error: out.slice(0, 500) };
  }
}

async function callTool(name, rawArgs) {
  let a = {};
  try { a = JSON.parse(rawArgs || '{}'); } catch { return { error: 'arguments were not valid JSON' }; }
  if (name === 'registry_lookup') return registryLookup(a);
  if (name === 'package_guidance_check') return guidanceCheck(a);
  if (name === 'package_guidance_guide') return { text: runCli(['guide', String(a.query || '')]).slice(0, 8000) };
  return { error: `unknown tool ${name}` };
}

// ------------------------------------------------------------------ model loop

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gateway availability gate. A gateway behind a VPN or a budget can disappear mid-run (403/401/402, connection
 * errors). Instead of burning through the queue as errors, every worker waits here until a cheap probe succeeds.
 */
let gatewayDown = null; // Promise while waiting
const GATEWAY_MAX_WAIT_MS = Number(process.env.CHOICE_GATEWAY_MAX_WAIT_MS || 6 * 3600e3);
async function waitForGateway(model) {
  gatewayDown ??= (async () => {
    const since = Date.now();
    console.log(`⏸  gateway unreachable: waiting (probing every 60s, up to ${GATEWAY_MAX_WAIT_MS / 3600e3}h)…`);
    for (;;) {
      await sleep(60_000);
      try {
        const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'OK' }] }), signal: AbortSignal.timeout(120_000) });
        if (res.ok) { console.log('▶  gateway is back, resuming'); gatewayDown = null; return; }
      } catch { /* still down */ }
      if (Date.now() - since > GATEWAY_MAX_WAIT_MS) { console.error('gateway did not come back; stopping. Re-run with the same --run-id to resume.'); process.exit(3); }
    }
  })();
  return gatewayDown;
}

const UNAVAILABLE = (status) => status === 401 || status === 402 || status === 403 || status === 407;

async function chat(model, messages, tools) {
  const body = { model, messages, ...(tools ? { tools, tool_choice: 'auto' } : {}) };
  for (let attempt = 0; ; attempt++) {
    if (gatewayDown) await gatewayDown;
    let res;
    try {
      res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
    } catch (e) {
      if (attempt < 2) { await sleep(5000 * (attempt + 1)); continue; } // transient network blip or slow model
      await waitForGateway(model);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    if (UNAVAILABLE(res.status)) { await waitForGateway(model); continue; }
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) { await sleep(2000 * 2 ** attempt); continue; }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function converse(model, arm, prompt) {
  const messages = [];
  if (arm === 'guided') messages.push({ role: 'system', content: skillPrompt() });
  messages.push({ role: 'user', content: prompt.prompt + fixtureContext(prompt) + TASK_SUFFIX });
  const tools = TOOLS[arm];
  let toolCalls = 0;
  const reasoning = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await chat(model, messages, tools);
    usage.prompt_tokens += r.usage?.prompt_tokens || 0;
    usage.completion_tokens += r.usage?.completion_tokens || 0;
    const raw = r.choices?.[0]?.message;
    if (!raw) throw new Error('no message in response');
    // Reasoning models return `reasoning_content` and provider fields; send back only the portable parts.
    const msg = { role: 'assistant', content: raw.content ?? '', ...(raw.tool_calls?.length ? { tool_calls: raw.tool_calls.map(({ id, type, function: f }) => ({ id, type: type || 'function', function: { name: f.name, arguments: f.arguments } })) } : {}) };
    messages.push(msg);
    if (raw.reasoning_content) reasoning.push(raw.reasoning_content.length);
    if (!msg.tool_calls?.length) return { answer: msg.content || '', messages, toolCalls, usage, reasoningChars: reasoning.reduce((a, b) => a + b, 0) };
    for (const tc of msg.tool_calls) {
      toolCalls++;
      const result = await callTool(tc.function.name, tc.function.arguments);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return { answer: messages.findLast((m) => m.role === 'assistant')?.content || '', messages, toolCalls, usage, truncated: true };
}

// ------------------------------------------------------------------ answer → manifests (independent of src/)

/** Pull dependency specs out of the commands in the answer's bash block(s). Deliberately simple and separate from the product's parser. */
export function extractSpecs(answer) {
  const blocks = [...answer.matchAll(/```(?:bash|sh|shell|zsh|console)?\n([\s\S]*?)```/g)].map((m) => m[1]);
  const lines = (blocks.length ? blocks.join('\n') : answer).replace(/\\\n/g, ' ').split(/\n|&&|;/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const npm = new Map();
  const pypi = new Map();
  const words = (l) => l.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["']|["']$/g, '')) ?? [];
  for (const raw of lines) {
    const w = words(raw.replace(/^\$\s*/, ''));
    const i = w.findIndex((x) => /^(npm|pnpm|yarn|bun|pip3?|uv|poetry)$/.test(x) || /^python3?$/.test(x));
    if (i < 0) continue;
    const tool = w[i];
    let rest = w.slice(i + 1);
    if (/^python3?$/.test(tool)) { if (rest[0] !== '-m' || !/^pip3?$/.test(rest[1] || '')) continue; rest = rest.slice(2); }
    const isPy = /^(pip3?|uv|poetry|python3?)$/.test(tool);
    // Find the subcommand by name, not position: `npm --prefix app install x` has a flag value first.
    const SUBS = isPy ? (tool === 'uv' ? ['add', 'pip'] : ['install', 'add']) : ['install', 'i', 'add'];
    const subIdx = rest.findIndex((x) => SUBS.includes(x));
    if (subIdx < 0) continue;
    // Anything before the subcommand must be a flag or a flag's value; otherwise it is e.g. `npm run add`.
    const before = rest.slice(0, subIdx);
    if (before.some((x, k) => !x.startsWith('-') && !before[k - 1]?.startsWith('-'))) continue;
    const sub = rest[subIdx];
    const VALUE_FLAGS = /^(--prefix|-C|--dir|--cwd|--filter|-F|-w|--workspace|--registry|--tag|-i|--index-url|--extra-index-url|-r|--requirement|-c|--constraint|-G|--group|--python|-p|--directory|--project)$/;
    const after = [];
    for (let k = subIdx + 1; k < rest.length; k++) {
      if (VALUE_FLAGS.test(rest[k])) { k++; continue; }
      if (!rest[k].startsWith('-')) after.push(rest[k]);
    }
    for (const spec of (tool === 'uv' && sub === 'pip' ? after.slice(1) : after)) {
      if (/^[.~/]|:\/\/|^-|^(file|git|github|workspace):/.test(spec) || spec.endsWith('.txt')) continue;
      if (isPy) {
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(spec);
        if (m) pypi.set(m[1].toLowerCase(), m[3] || '');
      } else {
        const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
        const name = at < 0 ? spec : spec.slice(0, at);
        if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) npm.set(name, at < 0 ? '*' : spec.slice(at + 1) || '*');
      }
    }
  }
  // Packages the answer defines itself (workspace members) are linked locally, not fetched:
  // `npm pkg set name=@repo/lib`, `npm init -w packages/x --scope=@repo`, or a written manifest's "name".
  const local = new Set();
  for (const m of answer.matchAll(/\bname=((?:@[\w.-]+\/)?[\w.-]+)/g)) local.add(m[1]);
  for (const m of answer.matchAll(/"name"\s*:\s*"((?:@[\w.-]+\/)?[\w.-]+)"/g)) local.add(m[1]);
  for (const m of answer.matchAll(/\bnpm init\b[^\n]*?(?:-w|--workspace)[ =]\S*?([\w.-]+)\b[^\n]*?--scope[ =](@[\w.-]+)/g)) local.add(`${m[2]}/${m[1]}`);
  for (const name of local) npm.delete(name);
  return { npm, pypi };
}

function writeSnapshot(dir, { npm, pypi }) {
  const snap = path.join(dir, 'snapshot');
  fs.mkdirSync(snap, { recursive: true });
  if (npm.size) writeJSON(path.join(snap, 'package.json'), { name: 'choice-eval', private: true, dependencies: Object.fromEntries(npm) });
  if (pypi.size) fs.writeFileSync(path.join(snap, 'requirements.txt'), [...pypi].map(([n, r]) => `${n}${r}`).join('\n') + '\n');
}

// ------------------------------------------------------------------ main

const jobs = [];
for (const model of MODELS) for (const arm of ARMS) for (const p of prompts) for (let seed = 1; seed <= SEEDS; seed++) jobs.push({ model, arm, p, seed });

console.log(`choice eval ${runId}: ${jobs.length} conversations = ${MODELS.length} models × ${ARMS.length} arms × ${prompts.length} prompts × ${SEEDS} seeds → ${BASE}`);
if (args['dry-run']) process.exit(0);
fs.mkdirSync(runDir, { recursive: true });
writeJSON(path.join(runDir, 'run.json'), { runId, kind: 'choice', baseUrl: BASE, models: MODELS, arms: ARMS, prompts: prompts.map((p) => p.id), seeds: SEEDS, createdAt: new Date().toISOString() });

let done = 0;
await pool(jobs, CONCURRENCY, async ({ model, arm, p, seed }) => {
  const dir = path.join(runDir, model.replace(/[^\w.-]+/g, '_'), arm, p.id, `seed-${seed}`);
  const prev = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : null;
  if (prev && prev.status !== 'error') { done++; return; } // resumable: finished conversations are kept, errors are retried
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = new Date();
  let meta;
  try {
    const r = await converse(model, arm, p);
    const specs = extractSpecs(r.answer);
    writeSnapshot(dir, specs);
    writeJSON(path.join(dir, 'transcript.json'), r.messages);
    fs.writeFileSync(path.join(dir, 'answer.md'), r.answer);
    meta = { status: r.truncated ? 'max-turns' : 'ok', toolCalls: r.toolCalls, usage: r.usage, deps: specs.npm.size + specs.pypi.size, skillTriggered: arm === 'guided' ? r.toolCalls > 0 : false };
  } catch (e) {
    meta = { status: 'error', error: String(e.message || e).slice(0, 500) };
  }
  writeJSON(path.join(dir, 'meta.json'), {
    runId, agent: model, arm, promptId: p.id, ecosystem: p.ecosystem || 'npm', seed, fixture: p.fixture || null,
    startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt.getTime(), costUsd: null, ...meta,
  });
  done++;
  console.log(`[${done}/${jobs.length}] ${model} ${arm} ${p.id} → ${meta.status}${meta.error ? `: ${meta.error.slice(0, 120)}` : ` (${meta.deps} deps, ${meta.toolCalls} tool calls)`}`);
});
console.log(`\nDone. Score with:\n  node score.mjs results/${runId} && node report.mjs results/${runId}`);
