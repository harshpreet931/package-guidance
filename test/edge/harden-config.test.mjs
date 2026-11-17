// Offline: `harden` edits the repo's own package-manager config without corrupting or weakening it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, dist, repo } from './cli-run.mjs';

const harden = (d, ...a) => cli(['harden', d, ...a]);
const read = (d, f) => readFileSync(join(d, f), 'utf8');
const count = (s, re) => (s.match(re) ?? []).length;

test('CRLF TOML: the new line keeps CRLF and lands after the header line', () => {
  const d = repo({ 'pyproject.toml': '[project]\r\nname = "x"\r\n\r\n[tool.uv]\r\ndev-dependencies = []\r\n', 'uv.lock': '' });
  harden(d, '--write');
  assert.equal(read(d, 'pyproject.toml'), '[project]\r\nname = "x"\r\n\r\n[tool.uv]\r\nexclude-newer = "7 days"\r\ndev-dependencies = []\r\n');
  const p = repo({ 'poetry.toml': '[solver]\r\nlazy-wheel = true\r\n', 'poetry.lock': '', 'pyproject.toml': '[tool.poetry]\r\n' });
  harden(p, '--write');
  assert.equal(read(p, 'poetry.toml'), '[solver]\r\nmin-release-age = 7\r\nlazy-wheel = true\r\n');
});

test('a header with a comment or spacing is found, never duplicated', () => {
  const d = repo({ 'pyproject.toml': '[ tool.uv ] # uv settings\npackage = false\n', 'uv.lock': '' });
  harden(d, '--write');
  assert.equal(read(d, 'pyproject.toml'), '[ tool.uv ] # uv settings\nexclude-newer = "7 days"\npackage = false\n');
});

test('false, env placeholders and fixed dates are left alone (no duplicate key, nothing lowered)', () => {
  for (const [file, body, extra] of [
    ['pyproject.toml', '[tool.uv]\nexclude-newer = false\n', { 'uv.lock': '' }],
    ['.npmrc', 'min-release-age=${MIN_AGE}\n', { 'package.json': '{}' }],
    ['pyproject.toml', '[tool.uv]\nexclude-newer = "2026-11-15T00:00:00Z"\n', { 'uv.lock': '' }],
  ]) {
    const d = repo({ [file]: body, ...extra });
    const r = harden(d, '--write');
    assert.equal(read(d, file), body, file);
    assert.match(r.out, /leaves alone/);
  }
});

test('an existing smaller value is raised in place with --write, only shown without it', () => {
  const body = 'packages:\n  - "packages/*"\nminimumReleaseAge: 60 # an hour\nother: 1\n';
  const d = repo({ 'pnpm-workspace.yaml': body, 'package.json': '{"packageManager":"pnpm@10.20.0"}' });
  assert.match(harden(d).out, /Raise it to:\s+minimumReleaseAge: 10080/);
  assert.equal(read(d, 'pnpm-workspace.yaml'), body);
  harden(d, '--write');
  assert.equal(read(d, 'pnpm-workspace.yaml'), body.replace(': 60 ', ': 10080 '));
});

test('an existing larger value is kept; running twice is idempotent', () => {
  const big = repo({ 'bunfig.toml': '[install]\nminimumReleaseAge = 1209600\n', 'package.json': '{"packageManager":"bun@1.3.2"}' });
  assert.match(harden(big, '--write').out, /Already enforced: 14d/);
  assert.equal(read(big, 'bunfig.toml'), '[install]\nminimumReleaseAge = 1209600\n');
  const body = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nregistry=https://r';
  const d = repo({ '.npmrc': body, 'package.json': '{}' });
  harden(d, '--write');
  harden(d, '--write');
  assert.equal(read(d, '.npmrc'), `${body}\nmin-release-age=7\n`, 'auth lines kept byte-for-byte');
});

test('only settings the detected package manager reads, in its own file and section, count', () => {
  const pnpm = repo({ '.npmrc': 'min-release-age=30\n', 'package.json': '{"packageManager":"pnpm@11.0.0"}' });
  assert.doesNotMatch(harden(pnpm).out, /Already enforced/);
  const bun = repo({ 'bunfig.toml': 'minimumReleaseAge = 604800\n[install]\nexact = true\n', 'package.json': '{"packageManager":"bun@1.3.2"}' });
  assert.doesNotMatch(harden(bun).out, /Already enforced/);
  harden(bun, '--write');
  assert.equal(read(bun, 'bunfig.toml'), 'minimumReleaseAge = 604800\n[install]\nminimumReleaseAge = 604800\nexact = true\n');
  const dotted = repo({ 'bunfig.toml': 'install.minimumReleaseAge = 604800\n', 'package.json': '{"packageManager":"bun@1.3.2"}' });
  assert.match(harden(dotted).out, /Already enforced/);
  const parent = repo({ '.npmrc': 'min-release-age=30\n', 'app/package.json': '{}' });
  assert.doesNotMatch(harden(join(parent, 'app')).out, /Already enforced/, "a parent's or ~/.npmrc is not the repo's");
});

test('uv.toml: a top-level key goes before the first table', () => {
  const d = repo({ 'uv.toml': '# uv config\n[[index]]\nurl = "https://x"\n', 'uv.lock': '', 'pyproject.toml': '[project]\n' });
  harden(d, '--write');
  assert.equal(read(d, 'uv.toml'), '# uv config\nexclude-newer = "7 days"\n[[index]]\nurl = "https://x"\n');
});

test('monorepos: writes to the workspace root, not the member', () => {
  const root = repo({ 'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n', 'pnpm-lock.yaml': '', 'package.json': '{}', 'packages/app/package.json': '{"name":"app"}' });
  harden(join(root, 'packages/app'), '--write');
  assert.ok(!existsSync(join(root, 'packages/app/pnpm-workspace.yaml')));
  assert.match(read(root, 'pnpm-workspace.yaml'), /^minimumReleaseAge: 10080$/m);
  const npm = repo({ 'package.json': '{"workspaces":["packages/*"]}', 'packages/a/package.json': '{}' });
  harden(join(npm, 'packages/a'), '--write');
  assert.ok(existsSync(join(npm, '.npmrc')) && !existsSync(join(npm, 'packages/a/.npmrc')));
});

test('no project: writes nothing; flow-style YAML is not rewritten', () => {
  const d = repo({ 'go.mod': 'module x\n' });
  const r = harden(d, '--write');
  assert.equal(r.code, 2);
  assert.ok(!existsSync(join(d, '.npmrc')));
  const flow = repo({ 'pnpm-workspace.yaml': '{packages: ["a/*"]}\n', 'pnpm-lock.yaml': '', 'package.json': '{}' });
  harden(flow, '--write');
  assert.equal(read(flow, 'pnpm-workspace.yaml'), '{packages: ["a/*"]}\n');
});

test('--cooldown 0 or nonsense is rejected', () => {
  for (const v of ['0', 'abc', '-5']) {
    const d = repo({ 'package.json': '{}' });
    const r = harden(d, `--cooldown=${v}`, '--write');
    assert.equal(r.code, 2, v);
    assert.ok(!existsSync(join(d, '.npmrc')), v);
  }
});

test('read-only config: a clean message, no stack trace', { skip: process.platform === 'win32' ? 'POSIX file permissions' : process.getuid?.() === 0 }, () => {
  const d = repo({ '.npmrc': 'registry=https://r\n', 'package.json': '{}' });
  chmodSync(join(d, '.npmrc'), 0o444);
  const r = harden(d, '--write');
  assert.match(r.out, /Could not write .*EACCES/);
  assert.doesNotMatch(r.err, /\n\s+at /);
  assert.equal(r.code, 3);
});

test('--json on every harden path', () => {
  const plan = JSON.parse(harden(repo({ 'package.json': '{}' }), '--json').out);
  assert.equal(plan.status, 'would-add');
  assert.equal(plan.line, 'min-release-age=7');
  assert.equal(JSON.parse(harden(repo({ '.npmrc': 'min-release-age=9\n', 'package.json': '{}' }), '--json').out).status, 'enforced');
  assert.equal(JSON.parse(harden(repo({ 'go.mod': '' }), '--json').out).status, 'no-project');
  assert.equal(JSON.parse(harden(repo({ 'package.json': '{}' }), '--json', '--cooldown', '0').out).exitCode, 2);
});

test('applyEdit keeps a missing final newline and the file EOL', async () => {
  const { applyEdit } = await dist('harden.js');
  assert.equal(applyEdit('a=1', { section: null, line: 'b=2' }), 'a=1\nb=2\n');
  assert.equal(applyEdit('a=1\r\nc=3', { section: null, line: 'b=2' }), 'a=1\r\nc=3\r\nb=2\r\n');
  assert.equal(applyEdit('[x]\r\n', { section: 'tool.uv', line: 'k = 1' }), '[x]\r\n\r\n[tool.uv]\r\nk = 1\r\n');
});
