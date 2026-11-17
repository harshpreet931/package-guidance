#!/usr/bin/env node
// Deterministic stand-in for an AI agent, used only to test run.mjs plumbing (`--agents mock`).
// It edits package.json / requirements.txt in cwd and prints a Claude-style JSON result.
// Guided arm is detected by the installed skill directory. No network, no AI.
import fs from 'node:fs';
const guided = fs.existsSync('.claude/skills/package-guidance');
if (fs.existsSync('requirements.txt') || fs.existsSync('pyproject.toml') || /fastapi|flask|python/i.test(process.argv.at(-1))) {
  fs.appendFileSync('requirements.txt', guided ? '\npyjwt==2.10.1\n' : '\nflask-jwt==0.3.2\n');
} else {
  const pj = fs.existsSync('package.json') ? JSON.parse(fs.readFileSync('package.json', 'utf8')) : { name: 'mock', version: '0.0.0' };
  pj.dependencies = { ...(pj.dependencies || {}), ...(guided ? { 'date-fns': '4.4.0' } : { moment: '^2.29.1', request: '^2.88.0' }) };
  fs.writeFileSync('package.json', JSON.stringify(pj, null, 2) + '\n');
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, session_id: null, result: 'mock done' }));
