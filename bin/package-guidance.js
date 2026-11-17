#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const dist = new URL('../dist/cli.js', import.meta.url);

if (existsSync(dist)) {
  const { main } = await import(dist.href);
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { process.stderr.write(`package-guidance: ${err?.stack ?? err}\n`); process.exitCode = 3; },
  );
} else {
  // A source checkout without a build (e.g. the Claude Code plugin, which is a git clone): run the
  // published build of this exact version instead. The npm package always contains dist/.
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const child = spawn('npx', ['--yes', `package-guidance@${version}`, ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', (err) => { process.stderr.write(`package-guidance: no build in this checkout and npx failed: ${err.message}\n`); process.exitCode = 3; });
  child.on('exit', (code) => { process.exitCode = code ?? 3; });
}
