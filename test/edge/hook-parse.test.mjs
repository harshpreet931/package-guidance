import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseInstalls } = await import(new URL('../../dist/shell.js', import.meta.url).href);
const confident = (cmd) => parseInstalls(cmd).flatMap((i) => i.specs.filter((s) => s.confident).map((s) => s.spec));

test('poetry, uvx and uv tool accept name@constraint', () => {
  assert.deepEqual(confident('poetry add ghost-pkg@^1.2'), ['ghost-pkg@^1.2']);
  assert.deepEqual(confident('poetry add ghost-pkg@latest'), ['ghost-pkg@latest']);
  assert.deepEqual(confident('uvx ghost-tool@0.6.0 check .'), ['ghost-tool@0.6.0']);
  assert.deepEqual(confident('uv tool install ghost-tool@latest'), ['ghost-tool@latest']);
  assert.deepEqual(confident('poetry add git+https://github.com/a/b.git'), []);
  assert.deepEqual(confident('pip install x@1'), [], 'pip has no @ syntax');
});

test('wrappers with their own flags and arguments do not hide the install', () => {
  for (const cmd of ['timeout 300 npm i ghost', 'timeout --signal=KILL 60s npm i ghost', 'sudo -E npm i -g ghost', 'sudo -u ci npm i ghost',
    'nice -n 10 npm i ghost', 'env -u CI npm i ghost', 'time -p npm i ghost', 'stdbuf -o L npm i ghost'])
    assert.deepEqual(confident(cmd), ['ghost'], cmd);
  assert.deepEqual(confident('command -v npm'), []);
  assert.deepEqual(confident('sudo -l npm i ghost'), []);
});

test('bash/sh/zsh -c scripts are parsed', () => {
  assert.deepEqual(confident(`bash -c 'cd web && npm i ghost'`), ['ghost']);
  assert.deepEqual(confident(`sh -c "pip install ghost"`), ['ghost']);
  assert.deepEqual(confident(`zsh -lc 'pnpm add ghost'`), ['ghost']);
  assert.deepEqual(confident(`bash -c 'echo "npm i ghost"'`), []);
});

test('installs after shell keywords are parsed', () => {
  assert.deepEqual(confident('if ! npm ls ghost; then npm i ghost; fi'), ['ghost']);
  assert.deepEqual(confident('for d in a b; do npm i ghost; done'), ['ghost']);
  assert.deepEqual(confident('{ npm i ghost; }'), ['ghost']);
});

test('a bash array assignment is not an install', () => {
  assert.deepEqual(confident('cmd=(npm i ghost) && echo "${cmd[@]}"'), []);
  assert.deepEqual(confident('arr=("a b" npm i ghost); npm i real'), ['real']);
});

test('registry flags are per tool: npm -f is --force, yarn -i is --interactive', () => {
  assert.equal(parseInstalls('npm i -f ghost')[0].customRegistry, false);
  assert.equal(parseInstalls('yarn add -i ghost')[0].customRegistry, false);
  assert.equal(parseInstalls('pip install -f https://wheels.corp x')[0].customRegistry, true);
  assert.equal(parseInstalls('poetry add --source corp x')[0].customRegistry, true);
});

test('a -p after the binary belongs to the binary', () => {
  for (const cmd of ['npx tsc -p tsconfig.build.json', 'npm exec -- tsc -p tsconfig.build.json', 'bun x tsc -p tsconfig.build.json', 'npx eslint --package foo .'])
    assert.ok(!confident(cmd).some((s) => s.startsWith('tsconfig') || s === 'foo'), cmd);
  assert.equal(parseInstalls('npx tsc -p tsconfig.json')[0].localBin, 'tsc');
});

test('--package / -p before the binary name the package to check', () => {
  for (const cmd of ['npx --package=typescript tsc', 'npx -p typescript tsc', 'pnpm dlx --package=typescript tsc', 'yarn dlx -p typescript tsc', 'pnpm --package=typescript dlx tsc', 'npm exec --package=typescript -- tsc'])
    assert.deepEqual(confident(cmd), ['typescript'], cmd);
  assert.deepEqual(confident('npx -p a -p b cmd'), ['a', 'b']);
  assert.equal(parseInstalls('npx -p typescript tsc')[0].localBin, null);
});

test('a registry set through the environment or a scoped flag counts as custom', () => {
  for (const cmd of ['npm_config_registry=https://npm.corp npm i acme', 'NPM_CONFIG_REGISTRY=https://npm.corp npm i acme', 'npm i --@acme:registry=https://npm.corp @acme/x',
    'npm i --@acme:registry https://npm.corp @acme/x', 'PIP_INDEX_URL=https://pypi.corp/simple pip install acme', 'UV_INDEX_URL=https://pypi.corp/simple uv add acme',
    'UV_DEFAULT_INDEX=https://pypi.corp/simple uv pip install acme', 'export PIP_INDEX_URL=https://pypi.corp/simple && pip install acme'])
    assert.equal(parseInstalls(cmd)[0].customRegistry, true, cmd);
  assert.equal(parseInstalls('npm_config_registry=https://registry.npmjs.org/ npm i acme')[0].customRegistry, false, 'the public registry is not custom');
  assert.equal(parseInstalls('PIP_INDEX_URL=https://pypi.corp/simple npm i acme')[0].customRegistry, false, 'other ecosystem');
  assert.deepEqual(confident('npm i --@acme:registry https://npm.corp @acme/x'), ['@acme/x']);
});

test('update commands with names are parsed; without names they are not', () => {
  const u = (cmd) => parseInstalls(cmd).map((i) => [i.pm, i.update, i.specs.map((s) => s.spec)]);
  assert.deepEqual(u('npm update zod'), [['npm', 'range', ['zod']]]);
  assert.deepEqual(u('npm up zod'), [['npm', 'range', ['zod']]]);
  assert.deepEqual(u('pnpm up -L zod'), [['pnpm', 'latest', ['zod']]]);
  assert.deepEqual(u('yarn up zod'), [['yarn', 'latest', ['zod']]]);
  assert.deepEqual(u('yarn upgrade zod'), [['yarn', 'range', ['zod']]]);
  assert.deepEqual(u('npm update'), []);
  assert.deepEqual(u('pnpm up'), []);
});

test('dry runs are flagged', () => {
  assert.equal(parseInstalls('npm i --dry-run ghost')[0].dryRun, true);
  assert.equal(parseInstalls('pip install --dry-run ghost')[0].dryRun, true);
  assert.equal(parseInstalls('npm i ghost')[0].dryRun, false);
});
