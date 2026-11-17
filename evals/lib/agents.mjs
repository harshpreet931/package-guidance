// Agent adapters. Each adapter knows how to (a) install the guidance into a temp repo for the
// guided arms, (b) build the headless command line, (c) parse the agent's output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const which = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
let helpCache = null;
function claudeHelp() {
  if (helpCache === null) helpCache = spawnSync('claude', ['--help'], { encoding: 'utf8' }).stdout || '';
  return helpCache;
}

const REPO_BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'bin', 'package-guidance.js');

/**
 * Copy the skill. Its commands (`npx -y package-guidance@X.Y.Z …`) are pointed at this repo's build, so the eval
 * measures the code under test rather than whatever is (or is not yet) published on npm.
 */
function copySkill(skillSrc, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(skillSrc, dst, { recursive: true });
  const skill = path.join(dst, 'SKILL.md');
  const text = fs.readFileSync(skill, 'utf8').replace(/npx -y package-guidance@[\w.-]+/g, `node ${REPO_BIN}`);
  fs.writeFileSync(skill, text);
}

/**
 * Guarded mode (default): instead of --dangerously-skip-permissions the agent gets an explicit allowlist:
 * file tools, web lookups, package managers and a few read-only shell commands. Anything else is denied.
 * Combined with GUARD_ENV, package managers write manifests and lockfiles but never install or run package code.
 */
const ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch', 'Skill',
  ...['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'pip', 'pip3', 'python', 'python3', 'uv', 'uvx', 'poetry', 'node',
    'ls', 'cat', 'head', 'tail', 'mkdir', 'cd', 'pwd', 'echo', 'grep', 'find', 'git', 'touch', 'cp', 'mv', 'wc', 'jq'].map((c) => `Bash(${c}:*)`),
];
export const GUARD_ENV = {
  npm_config_package_lock_only: 'true', // npm: resolve and write package.json + lockfile, no node_modules
  npm_config_ignore_scripts: 'true', // never run lifecycle scripts
  npm_config_lockfile_only: 'true', pnpm_config_lockfile_only: 'true', // pnpm equivalent
  YARN_ENABLE_SCRIPTS: 'false',
  UV_NO_SYNC: '1', // uv add: update pyproject.toml + uv.lock, do not install
  PIP_DRY_RUN: '1', // pip install: resolve only
};
function skillBody(skillSrc) {
  const raw = fs.readFileSync(path.join(skillSrc, 'SKILL.md'), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const desc = m ? (/^description:\s*(.*)$/m.exec(m[1])?.[1] || '').replace(/^["']|["']$/g, '') : '';
  return { body: m ? raw.slice(m[0].length) : raw, description: desc };
}

export const ADAPTERS = {
  claude: {
    bin: 'claude',
    stub: false,
    // Rough API-equivalent cost of one scaffold/feature task with a Sonnet-class default model.
    estimate: { usd: 0.9, low: 0.35, high: 2.5, minutes: 6 },
    available: () => which('claude'),
    installGuidance(work, { skillSrc, hook }) {
      copySkill(skillSrc, path.join(work, '.claude', 'skills', 'package-guidance'));
      if (hook) {
        const settingsPath = path.join(work, '.claude', 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        settings.hooks = hook;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      }
    },
    command(prompt, { model, maxBudgetUsd }) {
      const help = claudeHelp();
      const guarded = process.env.PG_EVAL_UNGUARDED !== '1';
      const args = ['-p', prompt, '--output-format', 'json', ...(guarded ? ['--allowedTools', ALLOWED_TOOLS.join(','), '--permission-mode', 'acceptEdits'] : ['--dangerously-skip-permissions'])];
      if (model) args.push('--model', model);
      if (maxBudgetUsd && help.includes('--max-budget-usd')) args.push('--max-budget-usd', String(maxBudgetUsd));
      // Isolation: ignore the operator's user-level settings/plugins/skills and MCP servers, so the
      // baseline arm can't accidentally see package-guidance installed globally.
      if (help.includes('--setting-sources')) args.push('--setting-sources', 'project,local');
      if (help.includes('--strict-mcp-config')) args.push('--strict-mcp-config');
      return { cmd: 'claude', args, transcriptFile: 'transcript.json' };
    },
    parse(stdout) {
      let j = null;
      try { j = JSON.parse(stdout.trim()); } catch {
        const last = stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
        try { j = last ? JSON.parse(last) : null; } catch { j = null; }
      }
      if (Array.isArray(j)) j = j.findLast?.((e) => e.type === 'result') || j[j.length - 1];
      if (!j) return { ok: false };
      return { ok: !j.is_error && j.subtype !== 'error_max_turns', costUsd: j.total_cost_usd ?? j.cost_usd ?? null, sessionId: j.session_id || null, turns: j.num_turns ?? null, result: typeof j.result === 'string' ? j.result.slice(0, 4000) : null, usage: j.usage || null, model: j.modelUsage ? Object.keys(j.modelUsage) : null };
    },
    /** Copy the full session log (tool calls) for the manipulation check. */
    collectSession(sessionId, resultDir) {
      if (!sessionId) return false;
      const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
      let dirs = [];
      try { dirs = fs.readdirSync(root); } catch { return false; }
      for (const d of dirs) {
        const f = path.join(root, d, `${sessionId}.jsonl`);
        if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(resultDir, 'session.jsonl')); return true; }
      }
      return false;
    },
  },

  // Deterministic no-AI stand-in for testing the harness plumbing (not a benchmark arm).
  mock: {
    bin: 'node',
    stub: false,
    estimate: { usd: 0, low: 0, high: 0, minutes: 0.01 },
    available: () => true,
    installGuidance(work, { skillSrc }) { copySkill(skillSrc, path.join(work, '.claude', 'skills', 'package-guidance')); },
    command(prompt) { return { cmd: process.execPath, args: [new URL('./mock-agent.mjs', import.meta.url).pathname, prompt], transcriptFile: 'transcript.json' }; },
    parse(stdout) { return ADAPTERS.claude.parse(stdout); },
    collectSession: () => false,
  },

  // ---- stubs: command lines are best-effort; verify against your installed CLI before relying on them ----
  codex: {
    bin: 'codex',
    stub: true,
    estimate: { usd: 0.6, low: 0.2, high: 2.0, minutes: 6 },
    available: () => which('codex'),
    installGuidance(work, { skillSrc }) {
      copySkill(skillSrc, path.join(work, '.agents', 'skills', 'package-guidance'));
      copySkill(skillSrc, path.join(work, '.codex', 'skills', 'package-guidance'));
      const { description } = skillBody(skillSrc);
      fs.appendFileSync(path.join(work, 'AGENTS.md'), `\n## Skills\n- package-guidance: ${description || 'how to choose and install dependencies'} — read .agents/skills/package-guidance/SKILL.md before adding or upgrading any dependency.\n`);
    },
    command(prompt, { model }) {
      const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
      if (model) args.push('-m', model);
      args.push(prompt);
      return { cmd: 'codex', args, transcriptFile: 'transcript.jsonl' };
    },
    parse(stdout) {
      const lines = stdout.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const done = lines.findLast?.((e) => /turn\.completed|task_complete/.test(e.type || e.msg?.type || ''));
      const failed = lines.some((e) => /error|turn\.failed/.test(e.type || ''));
      return { ok: !!done && !failed, costUsd: null, sessionId: lines.find((e) => e.thread_id)?.thread_id || null, usage: done?.usage || null };
    },
    collectSession: () => false,
  },

  cursor: {
    bin: 'cursor-agent',
    stub: true,
    estimate: { usd: 0.6, low: 0.2, high: 2.0, minutes: 6 },
    available: () => which('cursor-agent'),
    installGuidance(work, { skillSrc }) {
      const { body, description } = skillBody(skillSrc);
      const rules = path.join(work, '.cursor', 'rules');
      fs.mkdirSync(rules, { recursive: true });
      fs.writeFileSync(path.join(rules, 'package-guidance.mdc'), `---\ndescription: ${description || 'Choosing and installing dependencies'}\nalwaysApply: false\n---\n${body}`);
      copySkill(skillSrc, path.join(work, '.cursor', 'package-guidance'));
    },
    command(prompt, { model }) {
      const args = ['-p', '--force', '--output-format', 'json'];
      if (model) args.push('--model', model);
      args.push(prompt);
      return { cmd: 'cursor-agent', args, transcriptFile: 'transcript.json' };
    },
    parse(stdout) {
      let j = null;
      try { j = JSON.parse(stdout.trim().split('\n').pop()); } catch { j = null; }
      return { ok: !!j && !j.is_error, costUsd: null, sessionId: j?.session_id || null, result: j?.result?.slice?.(0, 4000) ?? null };
    },
    collectSession: () => false,
  },
};
