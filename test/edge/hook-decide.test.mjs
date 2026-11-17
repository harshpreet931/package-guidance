import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { decide, privateRegistry } = await import(new URL('../../dist/hook.js', import.meta.url).href);
const { parseInstalls } = await import(new URL('../../dist/shell.js', import.meta.url).href);
const { parseSpec } = await import(new URL('../../dist/check.js', import.meta.url).href);

const result = (o = {}) => ({
  name: 'x', requested: 'x', range: null, ecosystem: 'npm', verdict: 'ok', severity: 'ok', message: '', version: '1.0.0', resolved: '1.0.0',
  publishedAt: null, ageDays: 30, latest: { version: '1.0.0', publishedAt: '', ageDays: 30 }, wouldInstall: { version: '1.0.0', ageDays: 30 },
  fixedIn: null, advisories: [], entry: null, alternatives: [], guide: null, notes: [], installScripts: [], ...o,
});
const cooldown = { days: 7, source: 'default', configured: false };
const run = (cmd, results) => decide([{ install: parseInstalls(cmd)[0], cooldown, results }]);
const ghost = result({ verdict: 'not-found', severity: 'block', version: null, message: 'nope' });

test('a dry run is never denied, only noted', () => {
  assert.equal(run('npm i --dry-run ghost', [ghost]).kind, 'context');
  assert.equal(run('pip install --dry-run ghost', [result({ version: '1.0.0', wouldInstall: { version: '1.0.1', ageDays: 1 } })]).kind, 'none');
});

test('an update is held to the cooldown but not denied for an existing dependency being deprecated', () => {
  assert.equal(run('npm update zod', [result({ version: '1.0.0', wouldInstall: { version: '1.0.1', ageDays: 1 } })]).kind, 'deny');
  assert.equal(run('npm update request', [result({ verdict: 'deprecated', severity: 'block', version: null, message: 'old' })]).kind, 'context');
});

test('poetry and uvx @-constraints become PEP 440 ranges', () => {
  assert.deepEqual(parseSpec('pypi', 'requests@^2.1'), { name: 'requests', range: '>=2.1,<3' });
  assert.deepEqual(parseSpec('pypi', 'requests@^0.2.3'), { name: 'requests', range: '>=0.2.3,<0.3' });
  assert.deepEqual(parseSpec('pypi', 'requests@~1.2.3'), { name: 'requests', range: '>=1.2.3,<1.3' });
  assert.deepEqual(parseSpec('pypi', 'requests@~1'), { name: 'requests', range: '>=1,<2' });
  assert.deepEqual(parseSpec('pypi', 'ruff@latest'), { name: 'ruff', range: null });
  assert.deepEqual(parseSpec('pypi', 'ruff@>=0.6,<1'), { name: 'ruff', range: '>=0.6,<1' });
  assert.deepEqual(parseSpec('pypi', 'ruff@0.6.0'), { name: 'ruff', range: '==0.6.0' });
});

// Private-registry detection reads config files; HOME points at a scratch dir so the machine's own config is ignored.
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pg-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows
  delete process.env.XDG_CONFIG_HOME;
  try { return fn(home); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const project = (home, files) => {
  const dir = join(home, 'proj');
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
const isPrivate = (dir, cmd) => privateRegistry(dir, parseInstalls(cmd)[0]);

test('~/.npmrc counts even when the project has its own .npmrc', () => withHome((home) => {
  writeFileSync(join(home, '.npmrc'), 'registry=https://npm.corp.example/\n');
  assert.equal(isPrivate(project(home, { '.npmrc': 'save-exact=true\n' }), 'npm i internal-lib'), true);
}));

test('.npmrc scopes and the public registry', () => withHome((home) => {
  const dir = project(home, { '.npmrc': '@acme:registry=https://npm.acme.dev/\nregistry=https://registry.npmjs.org/\n' });
  assert.equal(isPrivate(dir, 'npm i @acme/utils'), true);
  assert.equal(isPrivate(dir, 'npm i left-pad'), false);
}));

test('.yarnrc.yml npmRegistryServer and npmScopes', () => withHome((home) => {
  assert.equal(isPrivate(project(home, { '.yarnrc.yml': 'npmRegistryServer: "https://npm.corp.example"\n' }), 'yarn add internal-lib'), true);
  const scoped = join(home, 'scoped');
  mkdirSync(scoped);
  writeFileSync(join(scoped, '.yarnrc.yml'), 'npmScopes:\n  acme:\n    npmRegistryServer: "https://npm.acme.dev"\nnodeLinker: node-modules\n');
  assert.equal(isPrivate(scoped, 'yarn add @acme/utils'), true);
  assert.equal(isPrivate(scoped, 'yarn add @other/utils'), false);
}));

test('bunfig.toml registry and scopes', () => withHome((home) => {
  assert.equal(isPrivate(project(home, { 'bunfig.toml': '[install]\nregistry = "https://npm.corp.example"\n' }), 'bun add internal-lib'), true);
  const scoped = join(home, 'scoped');
  mkdirSync(scoped);
  writeFileSync(join(scoped, 'bunfig.toml'), '[install.scopes]\nacme = { token = "x", url = "https://npm.acme.dev" }\n');
  assert.equal(isPrivate(scoped, 'bun add @acme/utils'), true);
  assert.equal(isPrivate(scoped, 'bun add left-pad'), false);
}));

test('uv, poetry and pip index config', () => withHome((home) => {
  assert.equal(isPrivate(project(home, { 'pyproject.toml': '[project]\nname = "a"\n\n[[tool.uv.index]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n' }), 'uv add internal-lib'), true);
  const poetry = join(home, 'poetry');
  mkdirSync(poetry);
  writeFileSync(join(poetry, 'pyproject.toml'), '[[tool.poetry.source]]\nname = "corp"\nurl = "https://pypi.corp.example/simple"\n');
  assert.equal(isPrivate(poetry, 'poetry add internal-lib'), true);
  const plain = join(home, 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'pyproject.toml'), '[project]\nname = "a"\n');
  assert.equal(isPrivate(plain, 'pip install requests'), false);
  mkdirSync(join(home, '.config', 'pip'), { recursive: true });
  writeFileSync(join(home, '.config', 'pip', 'pip.conf'), '[global]\nindex-url = https://pypi.corp.example/simple\n');
  assert.equal(isPrivate(plain, 'pip install internal-lib'), true);
  const appdata = join(home, 'AppData');
  mkdirSync(join(appdata, 'pip'), { recursive: true });
  rmSync(join(home, '.config'), { recursive: true });
  writeFileSync(join(appdata, 'pip', 'pip.ini'), '[global]\nindex-url = https://pypi.corp.example/simple\n');
  const savedAppdata = process.env.APPDATA;
  try {
    process.env.APPDATA = appdata;
    assert.equal(isPrivate(plain, 'pip install internal-lib'), true);
  } finally { if (savedAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAppdata; }
}));

test('registry variables in the hook process environment count, the public registry does not', () => withHome((home) => {
  const dir = project(home, {});
  const saved = process.env.npm_config_registry;
  try {
    process.env.npm_config_registry = 'https://registry.npmjs.org/'; // npm sets this for child processes
    assert.equal(isPrivate(dir, 'npm i internal-lib'), false);
    process.env.npm_config_registry = 'https://npm.corp.example/';
    assert.equal(isPrivate(dir, 'npm i internal-lib'), true);
  } finally { if (saved === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = saved; }
}));
