import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstalls, pinToken, rewrite, shellQuote, tokenize } from '../dist/shell.js';

/** [pm, kind, ...specs]; low-confidence specs are suffixed with `?`. */
const parsed = (cmd) => parseInstalls(cmd).map((i) => [i.pm, i.kind, ...i.specs.map((s) => s.spec + (s.confident ? '' : '?'))]);
/** Only confident specs: the ones the hook may deny on. */
const confident = (cmd) => parseInstalls(cmd).flatMap((i) => i.specs.filter((s) => s.confident).map((s) => s.spec));

test('tokenizer: operators, quotes, comments, redirects, heredocs, continuations', () => {
  assert.deepEqual(tokenize(`cd a && npm i "x y" || echo 'a;b'; ls | wc`), [['cd', 'a'], ['npm', 'i', 'x y'], ['echo', 'a;b'], ['ls'], ['wc']]);
  assert.deepEqual(tokenize('npm i express # add express for tests'), [['npm', 'i', 'express']]);
  assert.deepEqual(tokenize('npm install express > install.log 2>&1'), [['npm', 'install', 'express']]);
  assert.deepEqual(tokenize('npm i a &> out.txt'), [['npm', 'i', 'a']]);
  assert.deepEqual(tokenize('npm i a 2> err.txt'), [['npm', 'i', 'a']]);
  assert.deepEqual(tokenize('cat <<< "npm i x"'), [['cat']]);
  assert.deepEqual(tokenize('npm \\\n  install lodash'), [['npm', 'install', 'lodash']]);
  assert.deepEqual(tokenize("cat > README.md <<'EOF'\n# Install\nnpm install acme-unreleased-lib\nEOF\nnpm i zod"), [['cat'], ['npm', 'i', 'zod']]);
  assert.deepEqual(tokenize('cat <<-EOF\n\tpip install foo\n\tEOF\necho done'), [['cat'], ['echo', 'done']]);
});

test('npm family adds', () => {
  assert.deepEqual(parsed('npm install react react-dom@19'), [['npm', 'add', 'react', 'react-dom@19']]);
  assert.deepEqual(parsed('npm i -D vitest --save-exact'), [['npm', 'add', 'vitest']]);
  assert.deepEqual(parsed('pnpm add -w --filter web zod'), [['pnpm', 'add', 'zod']]);
  assert.deepEqual(parsed('yarn add @tanstack/react-query@^5'), [['yarn', 'add', '@tanstack/react-query@^5']]);
  assert.deepEqual(parsed('bun add hono'), [['bun', 'add', 'hono']]);
  assert.deepEqual(parsed('npm --prefix app install zod'), [['npm', 'add', 'zod']]);
  assert.deepEqual(parsed('npm i --before 2025-01-01 express'), [['npm', 'add', 'express']]);
  assert.deepEqual(parsed('npm i lodash4@npm:lodash@4.17.21'), [['npm', 'add', 'lodash@4.17.21']]);
});

test('unknown flags make the next argument low-confidence instead of a package', () => {
  assert.deepEqual(parsed('npm i --some-new-flag value express'), [['npm', 'add', 'value?', 'express']]);
  assert.deepEqual(confident('npm i --some-new-flag value express'), ['express']);
});

test('exec and create', () => {
  assert.deepEqual(parsed('npx create-react-app web'), [['npm', 'exec', 'create-react-app']]);
  assert.deepEqual(parsed('npx -y degit user/repo'), [['npm', 'exec', 'degit']]);
  assert.deepEqual(parsed('npx -p typescript tsc --init'), [['npm', 'exec', 'typescript']]);
  assert.deepEqual(parsed('npm create vite@latest my-app -- --template react-ts'), [['npm', 'exec', 'create-vite@latest']]);
  assert.deepEqual(parsed('npm init react-app web'), [['npm', 'exec', 'create-react-app']]);
  assert.deepEqual(parsed('pnpm create @vitejs/app'), [['pnpm', 'exec', '@vitejs/create-app']]);
  assert.deepEqual(parsed('pnpm dlx shadcn@latest init'), [['pnpm', 'exec', 'shadcn@latest']]);
  assert.deepEqual(parsed('bunx cowsay hi'), [['bun', 'exec', 'cowsay']]);
  assert.equal(parseInstalls('npx tsc --noEmit')[0].localBin, 'tsc', 'npx may run a local binary');
  assert.equal(parseInstalls('npx tsc@5 --noEmit')[0].localBin, null, 'an explicit version always downloads');
});

test('python installers', () => {
  assert.deepEqual(parsed('pip install "pydantic<2" fastapi[standard]'), [['pip', 'add', 'pydantic<2', 'fastapi[standard]']]);
  assert.deepEqual(parsed('python3 -m pip install -U requests==2.32.3'), [['pip', 'add', 'requests==2.32.3']]);
  assert.deepEqual(parsed('pip install --timeout 60 requests'), [['pip', 'add', 'requests']]);
  assert.deepEqual(parsed('uv add httpx --dev'), [['uv', 'add', 'httpx']]);
  assert.deepEqual(parsed('uv add --script example.py rich'), [['uv', 'add', 'rich']]);
  assert.deepEqual(parsed('uv pip install ruff'), [['uv', 'add', 'ruff']]);
  assert.deepEqual(parsed('uvx ruff check .'), [['uv', 'exec', 'ruff']]);
  assert.deepEqual(parsed('uv tool install --from black==24.1.0 black'), [['uv', 'exec', 'black==24.1.0']]);
  assert.deepEqual(parsed('poetry add -G dev pytest'), [['poetry', 'add', 'pytest']]);
  assert.deepEqual(parsed('pipx install httpie'), [['pip', 'add', 'httpie']]);
});

test('custom registries are flagged so a 404 is not called a hallucination', () => {
  assert.equal(parseInstalls('pip install --index-url https://my.corp/simple acme-lib')[0].customRegistry, true);
  assert.equal(parseInstalls('npm i --registry=https://npm.corp acme')[0].customRegistry, true);
  assert.equal(parseInstalls('npm i acme')[0].customRegistry, false);
});

test('never treats these innocent commands as installs', () => {
  const innocent = [
    'git status', 'git add . && git commit -m "npm install request"', 'git commit -m "bump npm deps, a fix"',
    'echo "npm install request"', 'grep -r "pip install" docs', 'ls node_modules', 'npm run build', 'npm test',
    'npm ci', 'npm install', 'pnpm install', 'yarn', 'yarn install --frozen-lockfile', 'bun install', 'uv sync', 'uv run pytest',
    'poetry install', 'pip install -r requirements.txt', 'pip install -e .', 'pip install .', 'pip install ./dist/pkg.whl',
    'npm i ./local-pkg', 'npm i ../x file:../y github:a/b user/repo https://x.com/a.tgz git+ssh://g',
    'pnpm add @acme/utils@workspace:*', 'pnpm add x@catalog:', 'npm i x@file:../x', 'pnpm exec tsc', 'yarn exec eslint .',
    'npm run lint -- --fix', 'bun run dev', 'npx', 'pip freeze > requirements.txt', 'pip list --outdated',
    'npm view react version', 'npm outdated', 'npm audit fix', 'npm ls', 'cat package.json', 'node -e "require(\'x\')"',
    "cat > README.md <<'EOF'\n## Install\nnpm install acme-unreleased-lib\nEOF",
    'echo $(npm view x version)', 'make install', 'brew install node', 'apt-get install -y python3-pip', 'cargo add serde',
    'go get github.com/x/y', 'gem install rails', 'npm config set registry https://r', 'npm pkg set name=x', 'npm exec -- tsc',
  ];
  for (const cmd of innocent) assert.deepEqual(confident(cmd), [], cmd);
});

test('quoting and rewriting keep the command intact', () => {
  assert.equal(shellQuote('react@19.0.0'), 'react@19.0.0');
  assert.equal(shellQuote('react@>=18 <19'), `'react@>=18 <19'`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const [install] = parseInstalls('npm i -D vitest request');
  const out = rewrite(install, new Map([[install.specs[0].index, 'vitest@3.2.4'], [install.specs[1].index, null]]));
  assert.equal(out, 'npm i -D vitest@3.2.4');
  const [py] = parseInstalls('pip install --index-url https://r "fastapi[standard]>=0.1"');
  const pinned = pinToken('pypi', py.words[py.specs[0].index], '0.115.0');
  assert.equal(pinned, 'fastapi[standard]==0.115.0', 'extras survive pinning');
  assert.equal(rewrite(py, new Map([[py.specs[0].index, pinned]])), `pip install --index-url https://r 'fastapi[standard]==0.115.0'`);
  assert.equal(pinToken('npm', 'lodash4@npm:lodash@^4', '4.17.21'), 'lodash4@npm:lodash@4.17.21');
  assert.equal(pinToken('npm', '@types/node', '22.0.0'), '@types/node@22.0.0');
});
