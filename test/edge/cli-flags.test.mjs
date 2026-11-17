// Offline: argument parsing, exit codes, JSON on every path, and output summaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIN, HIGH, cli, dist, repo } from './cli-run.mjs';

const FAKE = fileURLToPath(new URL('./cli-fake-fetch.mjs', import.meta.url));
const packages = { 'npm:acmeok': [['1.0.0', 300, true]], 'npm:acmebad': [['1.0.0', 300, true]] };

test('unknown flags are errors with a suggestion; JSON error when --json', () => {
  const r = cli(['check', 'acmeok', '--jsno']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown option --jsno\. Did you mean --json\?/);
  const j = cli(['check', 'acmeok', '--json', '--frobnicate']);
  assert.equal(JSON.parse(j.out).exitCode, 2);
  assert.match(cli(['check', '-x', 'acmeok']).err, /Unknown option -x/);
  assert.match(cli(['scan', '--cwd']).err, /--cwd needs a value/);
  assert.match(cli(['check', 'acmeok', '--pm', 'pnpn']).err, /Unknown package manager/);
});

test('--json=false is off; --json=true is on; boolean flags reject other values', async () => {
  const { parseArgs } = await dist('cli.js');
  assert.equal(parseArgs(['--json=false']).flags.json, false);
  assert.equal(parseArgs(['--json=true']).flags.json, true);
  assert.match(parseArgs(['--json=maybe']).errors[0], /takes no value/);
  assert.equal(parseArgs(['--cooldown', '3', 'x']).flags.cooldown, '3');
  assert.deepEqual(parseArgs(['--', '--not-a-flag'])._, ['--not-a-flag']);
  const r = cli(['check', 'acmeok', '--json=false'], { fake: { packages, osv: {} } });
  assert.throws(() => JSON.parse(r.out));
});

test('every error path prints valid JSON with --json', () => {
  for (const args of [['check', '--json'], ['frob', '--json'], ['scan', repo({ 'package.json': '{}' }), '--json'], ['harden', repo({ 'go.mod': '' }), '--json']]) {
    const r = cli(args);
    assert.doesNotThrow(() => JSON.parse(r.out), args.join(' '));
    assert.equal(JSON.parse(r.out).exitCode, r.code, args.join(' '));
  }
});

test('check: exit 4 and an Unverified line when OSV fails; the install line is kept', () => {
  const r = cli(['check', 'acmeok'], { fake: { packages, osv: 'fail' } });
  assert.equal(r.code, 4);
  assert.match(r.out, /Install {2}npm install acmeok@1\.0\.0/);
  assert.match(r.out, /Unverified {2}acmeok {2}the advisory lookup failed/);
  assert.equal(JSON.parse(cli(['check', 'acmeok', '--json'], { fake: { packages, osv: 'fail' } }).out).exitCode, 4);
});

test('check: registry outage exits 4 and says what was not checked; blocked exits 1', () => {
  const r = cli(['check', 'acmeok'], { fake: { registry: 'fail' } });
  assert.equal(r.code, 4);
  assert.match(r.out, /Not checked {2}acmeok/);
  const b = cli(['check', 'acmebad@1.0.0', 'nope-zz9'], { fake: { packages, osv: { 'acmebad@1.0.0': [HIGH('GHSA-x')] } } });
  assert.equal(b.code, 1);
  assert.match(b.out, /Blocked .*do not install$/m, 'no "alternatives above" when there are none');
  assert.equal(cli(['check', 'acmeok'], { fake: { packages, osv: {} } }).code, 0);
});

test('help documents the exit codes', () => {
  assert.match(cli(['--help']).out, /Exit codes[\s\S]*4 could not verify/);
});

test('EPIPE (output piped into a closed reader) exits quietly', { skip: process.platform === 'win32' && 'needs /bin/sh' }, () => {
  // More output than a pipe buffers, so the writer really hits the closed pipe.
  const names = Array.from({ length: 1500 }, (_, i) => `nope-zz9-${i}`).join(' ');
  const fx = join(mkdtempSync(join(tmpdir(), 'pg-fx-')), 'fake.json');
  writeFileSync(fx, '{}');
  const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" --import "${FAKE}" "${BIN}" check ${names} | head -c 1 >/dev/null`], {
    encoding: 'utf8', env: { ...process.env, PG_FAKE: fx, PACKAGE_GUIDANCE_NO_CACHE: '1' },
  });
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled/);
});
