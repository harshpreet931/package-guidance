import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../hooks/pre-tool-use.mjs', import.meta.url));
const { looksLikeInstall } = await import(new URL('../../hooks/pre-tool-use.mjs', import.meta.url).href);

test('the pre-filter lets through every install shape the parser understands', () => {
  const cmds = ['uv --directory backend add ghost', 'uv -q add ghost', 'poetry -C app add ghost', 'echo `npx ghost`', '/usr/local/bin/npx ghost',
    'npm ins ghost', 'npm instal ghost', 'pip --timeout 60 install ghost', 'python3 -m pip install ghost', 'pip3.12 install ghost', `bash -c 'npm i ghost'`,
    'pnpm --filter web add ghost', 'yarn global add ghost', 'pipx run ghost', 'uv tool run ghost', 'uvx ghost', 'npm update ghost', 'CI=1 npm i ghost'];
  assert.deepEqual(cmds.filter((c) => !looksLikeInstall(c)), []);
});

test('the pre-filter skips common commands that install nothing', () => {
  for (const cmd of ['git status', 'ls -la', 'npm run build', 'npm test', 'node -e "1"', 'cargo add serde', 'pytest -q', 'uv run pytest'])
    assert.equal(looksLikeInstall(cmd), false, cmd);
  assert.equal(looksLikeInstall(undefined), false);
  assert.equal(looksLikeInstall(123), false);
});

test('the pre-filter is linear: a 200-flag command takes under 50 ms', () => {
  const cmd = `npm ${Array.from({ length: 200 }, (_, i) => `--no-flag-${i}`).join(' ')} run build`;
  const t = performance.now();
  for (let i = 0; i < 10; i++) looksLikeInstall(cmd);
  assert.ok((performance.now() - t) / 10 < 50);
});

test('the pre-filter process exits 0 with no output on odd payloads', () => {
  for (const input of ['not json', 'null', '{"tool_input":{"command":123}}', '{"tool_input":{"command":"git status"}}']) {
    const r = spawnSync(process.execPath, [SCRIPT], { input, timeout: 5000 });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout.toString(), '', input);
  }
});
