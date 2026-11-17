import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectCooldown, detectPackageManager, resolveCooldown } from '../dist/project.js';

const repo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-'));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
};

test('reads cooldowns in each package manager\'s own unit', () => {
  assert.equal(detectCooldown(repo({ '.npmrc': 'min-release-age=3\n' }), 'npm').days, 3);
  assert.equal(detectCooldown(repo({ 'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n' }), 'npm').days, 1);
  assert.equal(detectCooldown(repo({ 'bunfig.toml': '[install]\nminimumReleaseAge = 259200\n' }), 'npm').days, 3);
  assert.equal(detectCooldown(repo({ 'pyproject.toml': '[tool.uv]\nexclude-newer = "7 days"\n' }), 'pypi').days, 7);
  assert.equal(detectCooldown(repo({}), 'npm'), null);
});

test('explicit flag beats repo config beats default', () => {
  const dir = repo({ '.npmrc': 'min-release-age=3\n' });
  assert.equal(resolveCooldown(dir, 'npm', '0').days, 0);
  assert.equal(resolveCooldown(dir, 'npm').source, '.npmrc min-release-age');
  assert.equal(resolveCooldown(repo({}), 'npm').days, 7);
});

test('detects the package manager', () => {
  assert.equal(detectPackageManager(repo({ 'package.json': '{"packageManager":"pnpm@10.0.0"}' }), 'npm'), 'pnpm');
  assert.equal(detectPackageManager(repo({ 'package.json': '{}', 'yarn.lock': '' }), 'npm'), 'yarn');
  assert.equal(detectPackageManager(repo({ 'pyproject.toml': '[tool.uv]\n' }), 'pypi'), 'uv');
});

test('exemptHint exempts the exact version where the package manager supports it', async () => {
  const { exemptHint } = await import('../dist/project.js');
  assert.match(exemptHint('pnpm', 'lib', '1.0.1'), /minimumReleaseAgeExclude: \['lib@1\.0\.1'\]/);
  assert.match(exemptHint('bun', 'lib', '1.0.1'), /minimumReleaseAgeExcludes = \["lib@1\.0\.1"\]/);
  assert.match(exemptHint('npm', 'lib', '1.0.1'), /min-release-age-exclude\[\]=lib/);
  assert.match(exemptHint('uv', 'lib', '1.0.1'), /exclude-newer-package = \{ lib = false \}/);
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry']) assert.match(exemptHint(pm, 'lib', '1.0.1'), /Remove the entry/);
});
