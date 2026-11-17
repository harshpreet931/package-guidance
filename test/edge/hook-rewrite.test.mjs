import { test } from 'node:test';
import assert from 'node:assert/strict';

const { decide } = await import(new URL('../../dist/hook.js', import.meta.url).href);
const { parseInstalls, rewrite } = await import(new URL('../../dist/shell.js', import.meta.url).href);

const result = (o = {}) => ({
  name: 'x', requested: 'x', range: null, ecosystem: 'npm', verdict: 'ok', severity: 'ok', message: '', version: '1.0.0', resolved: '1.0.0',
  publishedAt: null, ageDays: 30, latest: { version: '1.0.0', publishedAt: '', ageDays: 30 }, wouldInstall: { version: '1.0.0', ageDays: 30 },
  fixedIn: null, advisories: [], entry: null, alternatives: [], guide: null, notes: [], installScripts: [], ...o,
});
const fresh = (name) => result({ name, requested: name, version: '1.0.0', wouldInstall: { version: '1.0.1', ageDays: 1 } });
const ghost = (name) => result({ name, requested: name, verdict: 'not-found', severity: 'block', version: null, message: 'nope' });
const cooldown = { days: 7, source: 'default', configured: false };
const run = (cmd, perInstall) => decide(parseInstalls(cmd).map((install, k) => ({ install, cooldown, results: perInstall[k] })));
const runInstead = (d) => /Run instead: ([\s\S]*?)\nDo not retry/.exec(d.reason ?? '')?.[1];

test('keeps the cd chain, the rest of the command and comments byte for byte', () => {
  assert.equal(runInstead(run('cd packages/web && npm i zod && npm run build # deps', [[fresh('zod')]])), 'cd packages/web && npm i zod@1.0.0 && npm run build # deps');
});

test('keeps env assignments, ~ and $VAR exactly as typed', () => {
  assert.equal(runInstead(run('NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" npm i zod', [[fresh('zod')]])), 'NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" npm i zod@1.0.0');
  assert.equal(runInstead(run('npm i -g --prefix ~/.local zod', [[fresh('zod')]])), 'npm i -g --prefix ~/.local zod@1.0.0');
  assert.equal(runInstead(run('pip install --target "$VIRTUAL_ENV/lib" requests', [[fresh('requests')]])), 'pip install --target "$VIRTUAL_ENV/lib" requests==1.0.0');
});

test('never edits a low-confidence token', () => {
  const d = run('pip install --root-user-action ignore requests', [[result({ name: 'ignore', requested: 'ignore', version: '0.1.4' }), fresh('requests')]]);
  assert.equal(runInstead(d), 'pip install --root-user-action ignore requests==1.0.0');
  const dep = run('npm i --some-flag request zod', [[result({ name: 'request', verdict: 'deprecated', severity: 'warn', version: '2.88.2' }), fresh('zod')]]);
  assert.equal(runInstead(dep), 'npm i --some-flag request zod@1.0.0');
});

test('edits inside bash -c keep the outer quoting valid', () => {
  assert.equal(runInstead(run(`bash -c 'cd web && npm i zod'`, [[fresh('zod')]])), `bash -c 'cd web && npm i zod@1.0.0'`);
  assert.equal(runInstead(run(`sh -c 'pip install fastapi[x]'`, [[fresh('fastapi')]])), `sh -c 'pip install "fastapi[x]==1.0.0"'`);
  assert.equal(runInstead(run(`bash -c "pip install fastapi[x]"`, [[fresh('fastapi')]])), `bash -c "pip install 'fastapi[x]==1.0.0'"`);
});

test('one rewrite covers every install in the command', () => {
  assert.equal(runInstead(run('npm i zod && pip install requests', [[fresh('zod')], [fresh('requests')]])), 'npm i zod@1.0.0 && pip install requests==1.0.0');
  assert.equal(runInstead(run('npm i ghost zod && npm run build', [[ghost('ghost'), fresh('zod')]])), 'npm i zod@1.0.0 && npm run build');
});

test('no "Run instead" when a blocked install has nothing left to run', () => {
  assert.equal(runInstead(run('npm i ghost && npm run build', [[ghost('ghost')]])), undefined, 'a bare `npm i` would install everything');
  assert.equal(runInstead(run('npx ghost && npm i zod', [[ghost('ghost')], [fresh('zod')]])), undefined);
});

test('pins in --package=, npm update becomes install, aliases and extras survive', () => {
  const vuln = result({ name: 'zod', version: '1.0.1', verdict: 'vulnerable', severity: 'block', fixedIn: '1.0.1' });
  assert.equal(runInstead(run('npx --package=zod tsc', [[vuln]])), 'npx --package=zod@1.0.1 tsc');
  assert.equal(runInstead(run('npm update zod', [[fresh('zod')]])), 'npm install zod@1.0.0');
  assert.equal(runInstead(run('pnpm up zod', [[fresh('zod')]])), 'pnpm up zod@1.0.0');
  assert.equal(runInstead(run('npm i lodash4@npm:lodash', [[fresh('lodash')]])), 'npm i lodash4@npm:lodash@1.0.0');
  assert.equal(runInstead(run('poetry add requests@^2', [[result({ name: 'requests', version: '2.32.0', range: '>=2,<3', wouldInstall: { version: '2.32.1', ageDays: 1 } })]])), 'poetry add requests==2.32.0');
});

test('rewrite() of a single install still splices in place', () => {
  const [install] = parseInstalls('npm i -D vitest request');
  assert.equal(rewrite(install, new Map([[install.specs[0].index, 'vitest@3.2.4'], [install.specs[1].index, null]])), 'npm i -D vitest@3.2.4');
});
