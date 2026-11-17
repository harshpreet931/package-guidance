// Propagates package.json's version to every place that pins it. Runs automatically on `npm version`.
// The skill and hook pin an exact version on purpose: a tool that warns about fresh releases must not
// auto-run its own newest release via @latest.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const files = {
  'src/version.ts': [/VERSION = '[^']+'/, `VERSION = '${version}'`],
  '.claude-plugin/plugin.json': [/"version": "[^"]+"/, `"version": "${version}"`],
  'skills/package-guidance/SKILL.md': [/package-guidance@(?:\d+\.\d+\.\d+|latest)/g, `package-guidance@${version}`],
};
for (const [file, [pattern, replacement]] of Object.entries(files)) {
  const url = new URL(file, root);
  const before = readFileSync(url, 'utf8');
  const after = before.replace(pattern, replacement);
  if (after !== before) writeFileSync(url, after);
  console.log(`${after === before ? '=' : '✓'} ${file} → ${version}`);
}
