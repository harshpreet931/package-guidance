// Offline: the manifest and lockfile readers behind `scan`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist, repo } from './cli-run.mjs';

const { declaredNpm, declaredPypi } = await dist('scan.js');
const find = (ds, n, where) => ds.find((d) => d.name === n && (where === undefined || d.where === where));
const pj = (o) => JSON.stringify(o);
const LODASH = pj({ dependencies: { lodash: '^4.17.0' } });

// ---------------------------------------------------------------- npm lockfiles

test('package-lock v1, v3 and npm-shrinkwrap give the locked version', () => {
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'package-lock.json': pj({ lockfileVersion: 1, dependencies: { lodash: { version: '4.17.20' } } }) }))[0].version, '4.17.20');
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'package-lock.json': pj({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' } } }) }))[0].version, '4.17.20');
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'npm-shrinkwrap.json': pj({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.19' } } }) }))[0].version, '4.17.19');
});

test('pnpm-lock v9, v6 and v5 importers', () => {
  const v9 = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.20\n      react-dom:\n        specifier: ^18\n        version: 18.3.1(react@18.3.1)\n";
  const ds = declaredNpm(repo({ 'package.json': pj({ dependencies: { lodash: '^4.17.0', 'react-dom': '^18' } }), 'pnpm-lock.yaml': v9 }));
  assert.equal(find(ds, 'lodash').version, '4.17.20');
  assert.equal(find(ds, 'react-dom').version, '18.3.1', 'peer suffix stripped');
  const v6 = "lockfileVersion: '6.0'\n\ndependencies:\n  lodash:\n    specifier: ^4.17.0\n    version: 4.17.21\n";
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'pnpm-lock.yaml': v6 }))[0].version, '4.17.21');
  const v5 = 'lockfileVersion: 5.4\n\nspecifiers:\n  lodash: ^4.17.0\n\ndependencies:\n  lodash: 4.17.15\n';
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'pnpm-lock.yaml': v5 }))[0].version, '4.17.15');
});

test('yarn.lock classic and berry, with CRLF', () => {
  const classic = '# yarn lockfile v1\r\n\r\n"lodash@^4.16.0", lodash@^4.17.0:\r\n  version "4.17.20"\r\n  resolved "https://x"\r\n';
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'yarn.lock': classic }))[0].version, '4.17.20');
  const berry = '__metadata:\n  version: 8\n\n"lodash@npm:^4.16.0, lodash@npm:^4.17.0":\n  version: 4.17.19\n  resolution: "lodash@npm:4.17.19"\n';
  assert.equal(declaredNpm(repo({ 'package.json': LODASH, 'yarn.lock': berry }))[0].version, '4.17.19');
});

test('bun.lock (JSONC with trailing commas), including a member override', () => {
  const lock = '{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "root", }, },\n  "packages": {\n    "lodash": ["lodash@4.17.20", "", {}, "sha512-x"],\n    "app/lodash": ["lodash@4.17.11", "", {}, "sha512-y"],\n  },\n}\n';
  const ds = declaredNpm(repo({
    'package.json': pj({ name: 'root', workspaces: ['app'], dependencies: { lodash: '^4.17.0' } }),
    'app/package.json': pj({ name: 'app', dependencies: { lodash: '^4.17.0' } }),
    'bun.lock': lock,
  }));
  assert.equal(find(ds, 'lodash', undefined).version, '4.17.20');
  assert.equal(find(ds, 'lodash', 'app').version, '4.17.11');
});

test('an unreadable lockfile (merge conflict, bad JSON) warns and falls back to ranges', () => {
  for (const [file, body] of [['package-lock.json', '<<<<<<< HEAD\n{}\n'], ['yarn.lock', '<<<<<<< ours\nlodash@^4:\n  version "1.0.0"\n=======\n'], ['bun.lock', '{ nope']]) {
    const warnings = [];
    const ds = declaredNpm(repo({ 'package.json': LODASH, [file]: body }), warnings);
    assert.equal(ds[0].version, null, file);
    assert.match(warnings.join(' '), new RegExp(`Could not read ${file.replace('.', '\\.')}`));
  }
  const warnings = [];
  declaredNpm(repo({ 'package.json': LODASH, 'bun.lockb': 'binary' }), warnings);
  assert.match(warnings.join(' '), /bun\.lockb is binary/);
});

// ---------------------------------------------------------------- npm manifests

test('npm workspaces: siblings are skipped, members are scanned and labelled', () => {
  const ds = declaredNpm(repo({
    'package.json': pj({ name: 'root', workspaces: ['packages/*', '!packages/skip'], dependencies: { 'my-lib': '*', semver: '^7' } }),
    'packages/my-lib/package.json': pj({ name: 'my-lib', version: '1.0.0', dependencies: { lodash: '4.17.20', 'my-ui': '^1.0.0' } }),
    'packages/my-ui/package.json': pj({ name: 'my-ui', version: '1.0.0' }),
    'packages/skip/package.json': pj({ name: 'skip', dependencies: { leftpad: '1' } }),
    'package-lock.json': pj({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.20' }, 'packages/my-lib/node_modules/lodash': { version: '4.17.11' } } }),
  }));
  assert.deepEqual(ds.map((d) => `${d.where ?? '.'}:${d.name}`).sort(), ['.:semver', 'packages/my-lib:lodash']);
  assert.equal(find(ds, 'lodash').version, '4.17.11', "a member's nested copy wins over the hoisted one");
});

test('pnpm workspaces from pnpm-workspace.yaml, with ** globs', () => {
  const ds = declaredNpm(repo({
    'package.json': pj({ name: 'root' }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/**'\n  - \"libs/*\" # libraries\nminimumReleaseAge: 10080\n",
    'apps/web/site/package.json': pj({ name: 'site', dependencies: { lib: 'workspace:*', react: '^18' } }),
    'libs/lib/package.json': pj({ name: 'lib', dependencies: { zod: '^3' } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  apps/web/site:\n    dependencies:\n      react:\n        specifier: ^18\n        version: 18.2.0\n",
  }));
  assert.equal(find(ds, 'react', 'apps/web/site').version, '18.2.0');
  assert.ok(find(ds, 'zod', 'libs/lib'));
  assert.ok(!find(ds, 'lib'));
});

test('npm spec forms that are not registry ranges are skipped; aliases resolve', () => {
  const ds = declaredNpm(repo({ 'package.json': pj({ dependencies: {
    gh: 'user/repo#v1', gh2: 'user/repo', bb: 'bitbucket:x/y', gl: 'gitlab:x/y', jsr: 'jsr:@std/path@1', home: '~/x', win: 'C:\\x.tgz', cat: 'catalog:',
    ws: 'workspace:^', file: 'file:../x', url: 'https://x/y.tgz', link: 'link:../z',
    'my-react': 'npm:react@^18', 'no-ver': 'npm:left-pad', scoped: 'npm:@scope/pkg@1.2.3',
  } }) }));
  assert.deepEqual(ds.map((d) => `${d.name}@${d.range}`), ['react@^18', 'left-pad@', '@scope/pkg@1.2.3']);
});

test('dist-tags are checked as latest, with a note', () => {
  const [d] = declaredNpm(repo({ 'package.json': pj({ dependencies: { react: 'next' } }) }));
  assert.equal(d.range, '');
  assert.match(d.note, /"next" dist-tag/);
  assert.equal(declaredNpm(repo({ 'package.json': pj({ dependencies: { react: 'x' } }) }))[0].note, undefined, 'x is a wildcard, not a tag');
});

test('duplicate names across sections: runtime wins', () => {
  const ds = declaredNpm(repo({ 'package.json': pj({ dependencies: { react: '^18' }, devDependencies: { react: '^17' } }) }));
  assert.deepEqual(ds.map((d) => [d.range, d.dev]), [['^18', false]]);
});

test('BOM, invalid JSON, null and non-object fields do not throw', () => {
  assert.equal(declaredNpm(repo({ 'package.json': '\uFEFF{"dependencies":{"react":"^18"}}' }))[0].name, 'react');
  for (const body of ['{ "dependencies": { "react": "^18", } }', 'null', '[]']) {
    const warnings = [];
    assert.deepEqual(declaredNpm(repo({ 'package.json': body }), warnings), []);
    assert.equal(warnings.length, 1, body);
  }
  const warnings = [];
  assert.deepEqual(declaredNpm(repo({ 'package.json': pj({ dependencies: ['react'], devDependencies: { a: null, b: 1 } }) }), warnings), []);
  assert.match(warnings[0], /not an object/);
  assert.deepEqual(declaredNpm(repo({ 'package.json/x': '' })), [], 'package.json is a directory');
});

test('control characters in names are stripped before anything prints them', () => {
  const [d] = declaredNpm(repo({ 'package.json': pj({ dependencies: { 'x\u001b]0;pwned\u0007\u001b[2K': '1.0.0' } }) }));
  assert.doesNotMatch(d.name, /[\u0000-\u001f]/);
});

// ---------------------------------------------------------------- Python

const P = (s, extra = {}) => repo({ 'pyproject.toml': s, ...extra });
const names = (ds) => ds.map((d) => d.name).sort();

test('every optional-dependencies group and PEP 735 group; include-group is not a package', () => {
  const ds = declaredPypi(P('[project]\ndependencies = ["requests>=2"]\n[project.optional-dependencies]\nserver = ["urllib3==1.26.0"]\n"all" = ["x[server]"]\n[dependency-groups]\nci = ["pytest>=8"]\ndev = [{include-group = "ci"}, "ruff"]\n'));
  assert.deepEqual(names(ds), ['pytest', 'requests', 'ruff', 'urllib3', 'x']);
  assert.equal(find(ds, 'requests').dev, false);
});

test('uv sources (path, workspace, git) are not looked up on PyPI', () => {
  const ds = declaredPypi(P('[project]\ndependencies = ["mylib", "other", "six"]\n[tool.uv.sources]\nmylib = { path = "../mylib" }\n"other" = { workspace = true }\n'));
  assert.deepEqual(names(ds), ['six']);
});

test('Poetry: python skipped, quoted keys, inline tables, arrays, subtables, header comments, CRLF', () => {
  const ds = declaredPypi(P('[tool.poetry.dependencies] # runtime\r\npython = "^3.11"\r\nrequests = "^2.31"\r\n"quoted-name" = "^1.0"\r\ndjango = { extras = ["argon2"], version = "~4.2" }\r\nmylib = { path = "../mylib", develop = true }\r\ngitdep = { git = "https://github.com/a/b.git" }\r\nmulti = [ { version = "^1", python = "<3.12" }, { version = "^2", python = ">=3.12" } ]\r\n[tool.poetry.dependencies.flask]\r\nversion = "^3.0"\r\n[tool.poetry.dependencies.local]\r\npath = "../local"\r\n[tool.poetry.group.test.dependencies]\r\npytest = "^8"\r\n'));
  assert.deepEqual(names(ds), ['django', 'flask', 'multi', 'pytest', 'quoted-name', 'requests']);
  assert.equal(find(ds, 'requests').range, '>=2.31,<3');
  assert.equal(find(ds, 'django').range, '>=4.2,<4.3');
  assert.equal(find(ds, 'flask').range, '>=3.0,<4');
  assert.match(find(ds, 'multi').note, /several/);
  assert.equal(find(ds, 'pytest').dev, true);
});

test('dynamic dependencies: warns, and reads the files setuptools names', () => {
  const warnings = [];
  const ds = declaredPypi(P('[project]\nname = "x"\ndynamic = ["dependencies"]\n[tool.setuptools.dynamic]\ndependencies = {file = ["reqs/base.in"]}\n', { 'reqs/base.in': 'six==1.0\n' }), warnings);
  assert.deepEqual(names(ds), ['six']);
  assert.match(warnings.join(' '), /dynamic/);
});

test('requirements: -r (cycle-safe), -c pins, CRLF, BOM, continuations, hashes, URLs, paths, editables', () => {
  const ds = declaredPypi(repo({
    'requirements.txt': '\uFEFFflask>=1 # web\r\n-r base.txt\r\n-c constraints.txt\r\nnumpy==1.0 \\\r\n    --hash=sha256:abc\r\nhttps://example.com/pkg-1.0.whl\r\n./local\r\n-e git+https://x/y#egg=z\r\npkg @ https://x/pkg.whl\r\nDjango ; python_version < "3"\r\n',
    'base.txt': 'six==1.0\n--requirement requirements.txt\n-r missing.txt\n',
    'constraints.txt': 'Django==4.2.1\n',
  }));
  assert.deepEqual(names(ds), ['django', 'flask', 'numpy', 'six']);
  assert.equal(find(ds, 'flask').range, '>=1');
  assert.equal(find(ds, 'numpy').range, '==1.0');
  assert.equal(find(ds, 'django').version, '4.2.1');
});

test('requirements/ directory and dev files; runtime deps stay runtime when a dev file includes them', () => {
  const ds = declaredPypi(repo({ 'requirements.txt': 'six\n', 'requirements-dev.txt': '-r requirements.txt\npytest\n', 'requirements/docs.txt': 'sphinx\n' }));
  assert.deepEqual(names(ds), ['pytest', 'six', 'sphinx']);
  assert.equal(find(ds, 'six').dev, false);
  assert.equal(find(ds, 'pytest').dev, true);
});

test('Pipfile and setup.cfg are read; setup.py alone warns', () => {
  const pip = declaredPypi(repo({ Pipfile: '[packages]\nrequests = "*"\ndjango = { version = ">=4" }\nlocal = { path = "." }\n[dev-packages]\npytest = "==8.0"\n' }));
  assert.deepEqual(pip.map((d) => `${d.name}${d.range}${d.dev ? ' dev' : ''}`), ['requests', 'django>=4', 'pytest==8.0 dev']);
  const cfg = declaredPypi(repo({ 'setup.cfg': '[metadata]\nname = x\n[options]\ninstall_requires =\n    requests>=2\n    six  # compat\n[options.extras_require]\ntest =\n    pytest\n' }));
  assert.deepEqual(names(cfg), ['pytest', 'requests', 'six']);
  const warnings = [];
  assert.deepEqual(declaredPypi(repo({ 'setup.py': 'setup()' }), warnings), []);
  assert.match(warnings[0], /setup\.py/);
});

test('uv.lock / poetry.lock with CRLF and name normalisation', () => {
  const ds = declaredPypi(P('[project]\r\ndependencies = ["Foo_Bar>=1"]\r\n', { 'uv.lock': 'version = 1\r\n\r\n[[package]]\r\nname = "foo-bar"\r\nversion = "1.2.3"\r\n' }));
  assert.deepEqual(ds.map((d) => [d.name, d.version]), [['foo-bar', '1.2.3']]);
});
