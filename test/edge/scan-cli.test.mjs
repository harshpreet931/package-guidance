// Offline (fixtures via cli-fake-fetch.mjs): what `scan` reports and how it exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIGH, cli, repo } from './cli-run.mjs';

const pj = (o) => JSON.stringify(o);
const packages = { 'npm:lodash': [['4.17.20', 2000], ['4.18.1', 200, true]], 'npm:acmeok': [['7.6.0', 300, true]], 'pypi:urllib3': [['1.26.0', 2000], ['2.5.0', 100, true]] };
const vulnerable = { 'lodash@4.17.20': [HIGH('GHSA-1')] };

test('OSV outage: nothing counts as ok, the summary says unverified, exit 4', () => {
  const d = repo({ 'package.json': pj({ dependencies: { lodash: '4.17.20', acmeok: '^7' } }) });
  const r = cli(['scan', d], { fake: { packages, osv: 'fail' } });
  assert.match(r.out, /2 dependencies {2}2 unverified · 0 ok/);
  assert.match(r.out, /advisory lookup failed/);
  assert.equal(r.code, 4);
  const j = JSON.parse(cli(['scan', d, '--json'], { fake: { packages, osv: 'fail' } }).out);
  assert.deepEqual(j.unverified.sort(), ['acmeok', 'lodash']);
  assert.equal(j.exitCode, 4);
  assert.ok(j.results.every((x) => x.verdict !== 'ok'));
});

test('registry outage: "could not check", not "suggestions"; exit 4', () => {
  const d = repo({ 'package.json': pj({ dependencies: { lodash: '4.17.20' } }) });
  const r = cli(['scan', d], { fake: { registry: 'fail' } });
  assert.match(r.out, /1 dependency {2}1 could not check · 0 ok/);
  assert.doesNotMatch(r.out, /suggestion/);
  assert.equal(r.code, 4);
});

test('blocked wins over unverified (exit 1)', () => {
  const d = repo({ 'package.json': pj({ dependencies: { lodash: '4.17.20', 'no-such-pkg-zz9': '^1' } }) });
  const r = cli(['scan', d], { fake: { packages, osv: 'fail' } });
  assert.match(r.out, /1 blocking · 1 unverified · 0 ok/);
  assert.equal(r.code, 1);
});

test('a lockfile pin is what gets checked (pnpm), and a clean run exits 0', () => {
  const d = repo({ 'package.json': pj({ dependencies: { lodash: '^4.17.0' } }), 'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.20\n" });
  const r = cli(['scan', d], { fake: { packages, osv: vulnerable } });
  assert.match(r.out, /lodash 4\.17\.20\s+vulnerable/);
  assert.equal(r.code, 1);
  const clean = repo({ 'package.json': pj({ dependencies: { acmeok: '^7' } }) });
  const ok = cli(['scan', clean], { fake: { packages, osv: {} } });
  assert.match(ok.out, /1 dependency {2}1 ok/);
  assert.equal(ok.code, 0);
});

test('workspace members are scanned and labelled; siblings are not looked up', () => {
  const d = repo({
    'package.json': pj({ name: 'root', workspaces: ['packages/*'], dependencies: { 'my-lib': '*' } }),
    'packages/my-lib/package.json': pj({ name: 'my-lib', dependencies: { lodash: '4.17.20' } }),
  });
  const r = cli(['scan', d], { fake: { packages, osv: vulnerable } });
  assert.match(r.out, /packages\/my-lib › lodash 4\.17\.20/);
  assert.doesNotMatch(r.out, /not-found/);
});

test('a mixed npm + Python repo scans both ecosystems', () => {
  const d = repo({ 'package.json': pj({ dependencies: { acmeok: '^7' } }), 'requirements.txt': 'urllib3==1.26.0\n' });
  const r = cli(['scan', d, '--all'], { fake: { packages, osv: {} } });
  assert.match(r.out, /npm · cooldown/);
  assert.match(r.out, /pypi · cooldown/);
  assert.match(r.out, /urllib3/);
  const j = JSON.parse(cli(['scan', d, '--json'], { fake: { packages, osv: {} } }).out);
  assert.deepEqual(j.ecosystems.map((e) => e.ecosystem), ['npm', 'pypi']);
  assert.deepEqual(j.declared.map((x) => x.ecosystem), ['npm', 'pypi']);
  assert.match(cli(['scan', d, '--npm', '--all'], { fake: { packages, osv: {} } }).out, /^(?![\s\S]*pypi · cooldown)/, '--npm scans only npm');
});

test('warnings are shown (and in --json); nothing to scan is a usage error with JSON', () => {
  const d = repo({ 'package.json': pj({ dependencies: { acmeok: '^7' } }), 'package-lock.json': '<<<<<<< HEAD\n' });
  assert.match(cli(['scan', d], { fake: { packages, osv: {} } }).out, /Could not read package-lock\.json/);
  assert.match(JSON.parse(cli(['scan', d, '--json'], { fake: { packages, osv: {} } }).out).warnings[0], /merge conflicts/);
  const empty = cli(['scan', repo({ 'package.json': '{}' }), '--json']);
  assert.equal(empty.code, 2);
  assert.match(JSON.parse(empty.out).error, /No .*dependencies found/);
  assert.equal(cli(['scan', repo({ 'package.json': '﻿{"dependencies":{"acmeok":"^7"}}' })], { fake: { packages, osv: {} } }).code, 0, 'BOM');
});

test('terminal escapes in package.json names never reach stdout', () => {
  const d = repo({ 'package.json': pj({ dependencies: { 'x\u001b]0;pwned\u0007\u001b[2K': '1.0.0' } }) });
  assert.doesNotMatch(cli(['scan', d, '--all'], { fake: { packages, osv: {} } }).out, /\u001b|\u0007/);
});

test('a dist-tag is checked as latest and says so', () => {
  const d = repo({ 'package.json': pj({ dependencies: { acmeok: 'next' } }) });
  const r = cli(['scan', d, '--all', '-v'], { fake: { packages, osv: {} } });
  assert.doesNotMatch(r.out, /Could not understand/);
  assert.match(r.out, /"next" dist-tag/);
});

test('info-level "replace" advice (e18e) is hidden in scan unless --all; check still shows it', () => {
  const fake = { packages: { ...packages, 'npm:semver': [['7.6.0', 300, true]] }, osv: {} };
  const d = repo({ 'package.json': pj({ devDependencies: { semver: '^7' } }) });
  const r = cli(['scan', d], { fake });
  assert.doesNotMatch(r.out, /semver/);
  assert.match(r.out, /1 dependency {2}1 suggestion \(--all to show\) · 0 ok/);
  assert.equal(r.code, 0, 'suggestions never change the exit code');
  assert.match(cli(['scan', d, '--all'], { fake }).out, /→ semver \^7\s+replace/);
  assert.equal(JSON.parse(cli(['scan', d, '--json'], { fake }).out).results[0].verdict, 'replace', '--json stays complete');
  assert.match(cli(['check', 'semver'], { fake }).out, /→ semver\s+replace/);
});
