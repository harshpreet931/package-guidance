#!/usr/bin/env node
// Fast path for the package-guidance PreToolUse hook.
//
// It runs on every Bash call, so it must cost ~nothing when the command installs no packages: a cheap
// pre-filter here, and only commands that look like installs pay for the full check.
//
// The full check runs from this plugin's own build when present, otherwise from npm at the EXACT version this
// plugin ships, never `@latest`: a tool that warns about fresh releases must not auto-run its own.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A package-manager word plus an install-ish word anywhere in the command. A plain token scan: linear time, and
// deliberately loose, because the full parser is the real gate and a miss here is a missed check.
const PM = /^(npm|pnpm|yarn|bun|uv|poetry|pipx|pip(\d+(\.\d+)?)?)$/;
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);
const KEYWORDS = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add', 'a',
  'create', 'init', 'innit', 'exec', 'dlx', 'x', 'global', 'update', 'up', 'upgrade', 'udpate']);

export function looksLikeInstall(command) {
  if (typeof command !== 'string') return false;
  let pm = false, keyword = false, run = false, runner = false;
  for (const raw of command.split(/[\s;&|()<>`'"{}]+/)) {
    const t = raw.replace(/^.*[\\/]/, '').replace(/\.(cmd|exe)$/i, '');
    if (RUNNERS.has(t)) return true;
    if (PM.test(t)) { pm = true; if (t === 'pipx') runner = true; }
    else if (KEYWORDS.has(t)) keyword = true;
    else if (t === 'run') run = true;
    else if (t === 'tool') runner = true; // uv tool run
  }
  return pm && (keyword || (run && runner));
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let command;
    try { command = JSON.parse(input)?.tool_input?.command; } catch { process.exit(0); }
    if (process.env.PACKAGE_GUIDANCE_HOOK?.toLowerCase() === 'off' || !looksLikeInstall(command)) process.exit(0);

    const localBuild = `${ROOT}/dist/cli.js`;
    const bin = process.env.PACKAGE_GUIDANCE_BIN ?? (existsSync(localBuild) ? `${ROOT}/bin/package-guidance.js` : null);
    let cmd, args;
    if (bin) {
      [cmd, args] = [process.execPath, [bin, 'hook']];
    } else {
      const { version } = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'));
      [cmd, args] = ['npx', ['--yes', `package-guidance@${version}`, 'hook']];
    }
    const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'ignore'], shell: !bin && process.platform === 'win32' });
    child.on('error', () => process.exit(0)); // fail open
    child.on('exit', () => process.exit(0));
    child.stdin.end(input);
  });
}

// Importable for tests; runs only as the hook script.
const isMain = () => { try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] ?? ''); } catch { return false; } };
if (isMain()) main();
