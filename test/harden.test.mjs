import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit, settingLine } from '../dist/harden.js';
import { durationDays } from '../dist/project.js';

test('every manager gets 7 days in its own unit, and reads back as 7 days', () => {
  const units = { npm: 'days', pnpm: 'minutes', yarn: 'minutes', bun: 'seconds', uv: 'days', poetry: 'days' };
  for (const [pm, unit] of Object.entries(units)) {
    const line = settingLine(pm, 7);
    const value = line.split(/[=:]/).slice(1).join(':').trim();
    assert.equal(durationDays(value, unit), 7, `${pm}: ${line}`);
  }
  assert.equal(settingLine('pip', 7), 'uploaded-prior-to = P7D');
});

test('appends top-level settings without disturbing the file', () => {
  assert.equal(applyEdit('registry=https://r\n', { section: null, line: 'min-release-age=7' }), 'registry=https://r\nmin-release-age=7\n');
  assert.equal(applyEdit('a=1', { section: null, line: 'b=2' }), 'a=1\nb=2\n');
  assert.equal(applyEdit('', { section: null, line: 'b=2' }), 'b=2\n');
});

test('inserts under an existing TOML section, or creates it', () => {
  const toml = '[project]\nname = "x"\n\n[tool.uv]\ndev-dependencies = []\n';
  assert.equal(applyEdit(toml, { section: 'tool.uv', line: 'exclude-newer = "7 days"' }),
    '[project]\nname = "x"\n\n[tool.uv]\nexclude-newer = "7 days"\ndev-dependencies = []\n');
  assert.equal(applyEdit('[project]\nname = "x"\n', { section: 'tool.uv', line: 'exclude-newer = "7 days"' }),
    '[project]\nname = "x"\n\n[tool.uv]\nexclude-newer = "7 days"\n');
  assert.ok(!applyEdit('[tool.uvx]\n', { section: 'tool.uv', line: 'k = 1' }).startsWith('[tool.uvx]\nk = 1'), 'does not match a longer section name');
});
