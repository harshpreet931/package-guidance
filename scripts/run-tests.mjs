// Runs every test/**/*.test.mjs. Node 20's `--test` takes no globs, so the file list is built here.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = readdirSync('test', { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join('test', f))
  .sort();
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
