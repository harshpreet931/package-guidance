// Unit tests for the scorer's self-contained version + lockfile parsing. Run: node --test evals/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { satisfies, pySatisfies, pickVersion, cmpPep440 } from '../lib/versions.mjs';
import { extractDeps, parseRequirement } from '../lib/manifests.mjs';

test('npm ranges', () => {
  assert.ok(satisfies('2.29.4', '^2.29.1'));
  assert.ok(!satisfies('3.0.0', '^2.29.1'));
  assert.ok(satisfies('0.2.9', '^0.2.3') && !satisfies('0.3.0', '^0.2.3'));
  assert.ok(satisfies('1.2.9', '~1.2.3') && !satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('4.1.0', '>=4 <5') && satisfies('1.5.0', '1.x || >=3') && satisfies('3.1.0', '1.x || >=3'));
  assert.ok(satisfies('1.4.0', '1.2.3 - 1.4') && !satisfies('1.5.0', '1.2.3 - 1.4'));
  assert.ok(!satisfies('2.0.0-beta.1', '^1.0.0') && !satisfies('2.0.0-rc.1', '>=1'));
  assert.ok(satisfies('4.17.20', '4.17.20') && !satisfies('4.17.21', '4.17.20'));
});

test('pep440 specifiers', () => {
  assert.ok(pySatisfies('2.31.0', '>=2.28,<3'));
  assert.ok(pySatisfies('1.4.9', '~=1.4.2') && !pySatisfies('1.5.0', '~=1.4.2'));
  assert.ok(pySatisfies('2.0.5', '==2.0.*') && !pySatisfies('2.1.0', '==2.0.*'));
  assert.ok(pySatisfies('1.9.0', '^1.2') && !pySatisfies('2.0.0', '^1.2'));
  assert.ok(pySatisfies('0.3.9', '^0.3') && !pySatisfies('0.4.0', '^0.3'));
  assert.ok(!pySatisfies('2.0.0rc1', '>=1.0'));
  assert.ok(cmpPep440('1.0.post1', '1.0') > 0 && cmpPep440('1.0rc1', '1.0') < 0 && cmpPep440('1.0.dev1', '1.0a1') < 0);
});

test('pickVersion honours publish time', () => {
  const vs = ['1.0.0', '1.1.0', '1.2.0'];
  const t = { '1.0.0': 1, '1.1.0': 2, '1.2.0': 3 };
  assert.equal(pickVersion('npm', vs, t, '^1.0.0', { highest: true, atMs: 2 }), '1.1.0');
  assert.equal(pickVersion('npm', vs, t, '^1.0.0'), '1.0.0');
});

test('requirements lines', () => {
  assert.deepEqual(parseRequirement('requests[socks]>=2.31 ; python_version>"3.8"  # net'), { name: 'requests', spec: '>=2.31' });
  assert.equal(parseRequirement('-r base.txt'), null);
  assert.equal(parseRequirement('git+https://github.com/x/y'), null);
  assert.equal(parseRequirement('pkg @ https://x/y.whl').nonRegistry, true);
});

test('lockfile resolution: pnpm, yarn v1, yarn berry, bun, poetry', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-parse-'));
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  w('a/package.json', JSON.stringify({ dependencies: { zod: '^4.0.0', '@scope/x': '^1.0.0' } }));
  w('a/pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      '@scope/x':\n        specifier: ^1.0.0\n        version: 1.2.0(react@19.0.0)\n      zod:\n        specifier: ^4.0.0\n        version: 4.1.12\n\npackages:\n\n  zod@4.1.12:\n    resolution: {integrity: sha512-x}\n");
  w('b/package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0' } }));
  w('b/yarn.lock', '# yarn lockfile v1\n\n"lodash@^4.17.0", lodash@^4.17.15:\n  version "4.17.21"\n  resolved "https://x"\n');
  w('c/package.json', JSON.stringify({ dependencies: { lodash: '^4.17.0' } }));
  w('c/yarn.lock', '__metadata:\n  version: 8\n\n"lodash@npm:^4.17.0":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n');
  w('e/package.json', JSON.stringify({ dependencies: { zod: '^4.0.0' } }));
  w('e/bun.lock', '{\n  "lockfileVersion": 1,\n  "packages": {\n    "zod": ["zod@4.1.12", "", {}, "sha512-x"],\n  },\n}\n');
  w('f/pyproject.toml', '[tool.poetry]\nname = "f"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nRequests = "^2.31"\nfastapi = { version = "^0.115", extras = ["all"] }\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n');
  w('f/poetry.lock', '[[package]]\nname = "requests"\nversion = "2.32.3"\n\n[[package]]\nname = "fastapi"\nversion = "0.115.6"\n');
  const { deps } = extractDeps(d);
  const get = (m, n) => deps.find((x) => x.manifest.startsWith(m) && x.name === n);
  assert.equal(get('a/', 'zod').lockVersion, '4.1.12');
  assert.equal(get('a/', '@scope/x').lockVersion, '1.2.0');
  assert.equal(get('b/', 'lodash').lockVersion, '4.17.21');
  assert.equal(get('c/', 'lodash').lockVersion, '4.17.21');
  assert.equal(get('e/', 'zod').lockVersion, '4.1.12');
  assert.equal(get('f/', 'requests').lockVersion, '2.32.3');
  assert.equal(get('f/', 'fastapi').spec, '^0.115');
  assert.equal(get('f/', 'pytest').dev, true);
  assert.equal(deps.some((x) => x.name === 'python'), false);
  fs.rmSync(d, { recursive: true, force: true });
});
