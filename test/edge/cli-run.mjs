// Shared by the scan-/harden-/cli- edge tests: temp fixture repos and an offline CLI runner.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, '..', '..', 'bin', 'package-guidance.js');
export const dist = (m) => import(new URL(`../../dist/${m}`, import.meta.url).href);

export function repo(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pg-edge-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}

/** Run the CLI offline: `fake` is the fixture for cli-fake-fetch.mjs (see there). */
export function cli(args, { fake = {}, env = {}, input } = {}) {
  const fx = join(mkdtempSync(join(tmpdir(), 'pg-fx-')), 'fake.json');
  writeFileSync(fx, JSON.stringify(fake));
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(HERE, 'cli-fake-fetch.mjs')).href, BIN, ...args], {
    encoding: 'utf8', timeout: 30_000, input,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', PACKAGE_GUIDANCE_NO_CACHE: '1', PACKAGE_GUIDANCE_COOLDOWN: '', PG_FAKE: fx, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export const HIGH = (id) => ({ id, summary: 'bad', database_specific: { severity: 'HIGH' } });
