/**
 * Claude Code PreToolUse hook. Reads the hook payload on stdin; for Bash commands that install packages it
 *   - denies installs that are hallucinated, malicious, deprecated, known-vulnerable or curated "never use",
 *   - denies installs that would pull a release younger than the cooldown, and says exactly what to run instead,
 *   - otherwise adds non-blocking context for warnings, and stays silent when everything is fine.
 *
 * Guarantees: it never approves anything (no `allow`), so the normal permission flow is untouched; it denies only
 * on specs the parser is confident about; and it fails open, so a network error or timeout produces no output.
 *
 * Modes (PACKAGE_GUIDANCE_HOOK): `strict` (default) · `warn` (never deny, only add context) · `off`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkMany, formatAge, installable, type CheckResult } from './check.ts';
import { exemptHint, findUp, resolveCooldown, type Cooldown } from './project.ts';
import { isPublicRegistry, parseInstalls, pinToken, privateRegistryVar, rewriteCommand, type Change, type Install } from './shell.ts';

const BUDGET_MS = Number(process.env.PACKAGE_GUIDANCE_HOOK_BUDGET_MS) || 9000;

export interface HookInput { tool_name?: string; tool_input?: { command?: string }; cwd?: string }
export type HookDecision = { kind: 'none' } | { kind: 'deny'; reason: string } | { kind: 'context'; text: string };

export interface Assessed {
  install: Install;
  cooldown: Cooldown;
  /** One result per spec in `install.specs`, same order. */
  results: CheckResult[];
  /** The registry for this install is not the public one (flags, env or package-manager config), so a 404 proves nothing. */
  privateRegistry?: boolean;
}

/** Registry-controlled text (deprecation messages, advisory titles) is data, never instructions. */
const quoted = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** Pure policy: given what we found, what should the hook do? */
export function decide(assessed: Assessed[], mode: 'strict' | 'warn' = 'strict'): HookDecision {
  const problems: string[] = [];
  const warnings: string[] = [];
  const changes: Change[] = [];
  let fixable = true;

  for (const { install, cooldown, results, privateRegistry } of assessed) {
    const replace = new Map<number, string | null>();
    let blocked = false;

    results.forEach((r, i) => {
      const spec = install.specs[i]!;
      const original = spec.raw;
      const alt = r.alternatives.length && (!installable(r) || r.verdict === 'replace') ? ` Use instead: ${r.alternatives.slice(0, 3).join(', ')}.` : '';
      const guide = r.guide ? ` Guide: \`npx package-guidance guide ${r.guide}\`.` : '';
      const curated = r.entry !== null;
      const detail = r.verdict === 'deprecated' && !curated ? `registry note: ${quoted(r.message)}` : r.message;
      const line = `${r.requested}: ${r.verdict}. ${detail}${/[.!?"]$/.test(detail) ? '' : '.'}${alt}${guide}`;

      const wouldInstallFresh =
        install.kind === 'add' && !cooldown.configured && r.version !== null && r.wouldInstall !== null &&
        r.wouldInstall.version !== r.version && r.wouldInstall.ageDays < cooldown.days && r.fixedIn !== r.wouldInstall.version;
      const notFoundButPrivate = r.verdict === 'not-found' && !!privateRegistry;
      // A dry run installs nothing; low-confidence specs may be flag values.
      const canBlock = spec.confident && !notFoundButPrivate && !install.dryRun;
      // An update moves a dependency the project already has: only the cooldown is grounds to stop it.
      const blocking = r.severity === 'block' && !install.update;

      if (blocking && canBlock) {
        problems.push(`✗ ${line}`);
        blocked = true;
        replace.set(spec.index, installable(r) ? pinToken(install.ecosystem, original, r.version!) : null);
      } else if (wouldInstallFresh && canBlock) {
        problems.push(`! ${r.name}: this would install ${r.wouldInstall!.version}, published ${formatAge(r.wouldInstall!.ageDays)} ago (cooldown ${cooldown.days}d). Pin the settled version ${r.version}.`);
        blocked = true;
        replace.set(spec.index, pinToken(install.ecosystem, original, r.version!));
      } else {
        if (notFoundButPrivate) return; // expected: the package lives on a private registry
        if (r.severity === 'block' || r.severity === 'warn' || (r.severity === 'info' && r.verdict !== 'ok' && curated)) warnings.push(line);
        if (!spec.confident) return; // never edit a token that might be a flag's value
        // A package we just told the agent to replace or drop does not belong in "Run instead".
        if (r.verdict === 'replace' || r.verdict === 'deprecated') replace.set(spec.index, null);
        // Unpinned requests get pinned to what we checked; explicit ranges are kept as the agent wrote them.
        else if (install.kind === 'add' && r.version && r.range === null && installable(r)) replace.set(spec.index, pinToken(install.ecosystem, original, r.version));
      }
    });

    if (!replace.size) continue;
    // Dropping every package would leave a bare `npm i` (install everything) or `npx` with nothing to run.
    if (install.specs.every((s) => replace.get(s.index) === null)) {
      if (blocked) fixable = false;
      continue;
    }
    changes.push({ install, replace });
  }

  const fix = fixable && problems.length && changes.length ? rewriteCommand(changes) : null;
  if (problems.length && mode === 'strict') {
    const lines = ['package-guidance blocked this install:', ...problems.map((p) => `  ${p}`)];
    if (warnings.length) lines.push('Also:', ...warnings.map((w) => `  ${w}`));
    if (fix) lines.push(`Run instead: ${fix}`);
    lines.push('Do not retry the same command, do not guess similar package names, and do not lower or bypass a configured cooldown.');
    return { kind: 'deny', reason: lines.join('\n') };
  }
  const notes = [...problems, ...warnings];
  if (!notes.length) return { kind: 'none' };
  const text = ['package-guidance:', ...notes.map((n) => `  ${n}`)];
  if (fix) text.push(`Suggested: ${fix}`);
  return { kind: 'context', text: text.join('\n') };
}

/** npx/bunx/npm exec prefer an installed binary; if one exists nothing is downloaded. */
function hasLocalBin(cwd: string, bin: string): boolean {
  let d = resolve(cwd);
  for (;;) {
    if (existsSync(join(d, 'node_modules', '.bin', bin))) return true;
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

const read = (p: string | undefined): string => {
  if (!p) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
};

/** Every `name` from `cwd` up to the root, nearest first. */
function allUp(cwd: string, name: string): string[] {
  const out: string[] = [];
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, name))) out.push(join(d, name));
    if (dirname(d) === d) return out;
  }
}

/** Indented `key:` entries of a top-level YAML map, e.g. the scopes under `npmScopes:`. */
function yamlKeys(text: string, block: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${block}\\s*:\\s*$`).test(l));
  if (at === -1) return [];
  const keys: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l)) break;
    const m = /^ {1,4}["']?@?([\w.-]+)["']?\s*:/.exec(l);
    if (m && !/^\s{5,}/.test(l)) keys.push(m[1]!);
  }
  return keys;
}

/** npm, pnpm, yarn or bun config sends this package to a non-public registry. Every config level counts. */
function npmPrivate(cwd: string, name: string): boolean {
  const home = homedir();
  const scope = name.startsWith('@') ? name.slice(1, name.indexOf('/')) : null;
  const npmrcs = [...allUp(cwd, '.npmrc'), process.env.npm_config_userconfig ?? process.env.NPM_CONFIG_USERCONFIG, join(home, '.npmrc')];
  for (const text of npmrcs.map(read)) {
    for (const m of text.matchAll(/^\s*(?:@([^:\s]+):)?registry\s*=\s*(\S+)/gm)) {
      if ((!m[1] || m[1] === scope) && !isPublicRegistry(m[2]!)) return true;
    }
  }
  for (const text of [...allUp(cwd, '.yarnrc.yml'), join(home, '.yarnrc.yml')].map(read)) {
    const server = /^npmRegistryServer\s*:\s*(\S+)/m.exec(text)?.[1];
    if (server && !isPublicRegistry(server)) return true;
    if (scope && yamlKeys(text, 'npmScopes').includes(scope)) return true;
  }
  for (const text of [...allUp(cwd, 'bunfig.toml'), join(home, '.bunfig.toml')].map(read)) {
    const registry = /^\s*registry\s*=\s*(?:\{[^}]*url\s*=\s*)?["']([^"']+)["']/m.exec(text)?.[1];
    if (registry && !isPublicRegistry(registry)) return true;
    const scopes = /^\s*\[install\.scopes\]([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text)?.[1] ?? '';
    if (scope && new RegExp(`^\\s*["']?@?${scope.replace(/[.-]/g, '\\$&')}["']?\\s*=`, 'm').test(scopes)) return true;
  }
  return false;
}

/** pip, uv or poetry is configured with another index: a PyPI 404 proves nothing. */
function pypiPrivate(cwd: string): boolean {
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  const files = [
    ...allUp(cwd, 'uv.toml'), ...allUp(cwd, 'pyproject.toml'), ...allUp(cwd, 'poetry.toml'), ...allUp(cwd, 'pip.conf'),
    process.env.PIP_CONFIG_FILE, process.env.UV_CONFIG_FILE, process.env.VIRTUAL_ENV && join(process.env.VIRTUAL_ENV, 'pip.conf'),
    join(config, 'pip', 'pip.conf'), join(home, '.pip', 'pip.conf'), join(home, 'Library', 'Application Support', 'pip', 'pip.conf'),
    join(config, 'uv', 'uv.toml'), '/etc/pip.conf', '/etc/uv/uv.toml',
    // Windows: pip reads pip.ini (per user, per venv, legacy ~/pip), uv reads %APPDATA%\\uv\\uv.toml.
    ...allUp(cwd, 'pip.ini'), process.env.VIRTUAL_ENV && join(process.env.VIRTUAL_ENV, 'pip.ini'), join(home, 'pip', 'pip.ini'),
    process.env.APPDATA && join(process.env.APPDATA, 'pip', 'pip.ini'), process.env.APPDATA && join(process.env.APPDATA, 'uv', 'uv.toml'),
  ];
  return files.some((f) => {
    const text = read(f || undefined);
    if (/^\s*\[\[\s*(tool\.uv\.)?index\s*\]\]|^\s*\[\[?\s*tool\.poetry\.source\s*\]\]?|^\s*find-links\s*=\s*\S/m.test(text)) return true;
    return [...text.matchAll(/^\s*(?:extra-)?index-url\s*=\s*(\S+)/gm)].some((m) => !isPublicRegistry(m[1]!));
  });
}

/** Exported for tests. */
export function privateRegistry(cwd: string, install: Install): boolean {
  if (install.customRegistry) return true;
  if (Object.entries(process.env).some(([k, v]) => privateRegistryVar(install.ecosystem, k, v))) return true;
  return install.ecosystem === 'npm' ? install.specs.some((s) => npmPrivate(cwd, nameOf(s.spec))) : pypiPrivate(cwd);
}

function nameOf(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

/**
 * `npm update x` stays inside the range package.json gives x, so check that range. A name the manifest does not
 * list is not updated at all, so it is dropped.
 */
function updateInstall(cwd: string, install: Install): Install {
  if (install.update !== 'range') return install;
  let manifest: Record<string, Record<string, string> | undefined> = {};
  try { manifest = JSON.parse(read(findUp(cwd, ['package.json']) ?? undefined) || '{}'); } catch { /* unreadable: nothing to update */ }
  const ranges = { ...manifest.optionalDependencies, ...manifest.devDependencies, ...manifest.dependencies };
  const specs = install.specs.flatMap((s) => {
    if (s.spec.slice(1).includes('@')) return [s];
    const range = ranges[s.spec];
    if (typeof range !== 'string') return [];
    return /^[\w.^~<>=|*\s-]+$/.test(range) ? [{ ...s, spec: `${s.spec}@${range}` }] : [];
  });
  return { ...install, specs };
}

export async function runHook(input: HookInput): Promise<HookDecision> {
  const mode = (process.env.PACKAGE_GUIDANCE_HOOK ?? 'strict').toLowerCase();
  const command = input?.tool_input?.command;
  if (mode === 'off' || input?.tool_name !== 'Bash' || typeof command !== 'string' || !command) return { kind: 'none' };
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const installs = parseInstalls(command)
    .filter((i) => !(i.localBin && hasLocalBin(cwd, i.localBin)))
    .map((i) => updateInstall(cwd, i))
    .filter((i) => i.specs.length);
  if (!installs.length) return { kind: 'none' };

  const assessed = await Promise.all(
    installs.map(async (install): Promise<Assessed> => {
      const cooldown = resolveCooldown(cwd, install.ecosystem, undefined, install.pm);
      const results = await checkMany(install.specs.map((s) => s.spec), {
        ecosystem: install.ecosystem, cooldownDays: cooldown.days, cooldownSource: cooldown.source, fast: true,
        exemptFresh: cooldown.configured ? (name, version) => exemptHint(install.pm, name, version) : undefined,
      });
      const isPrivate = results.some((r) => r.verdict === 'not-found') && privateRegistry(cwd, install);
      return { install, cooldown, results, privateRegistry: isPrivate };
    }),
  );
  return decide(assessed, mode === 'warn' ? 'warn' : 'strict');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function cmdHook(): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    return 0; // not a hook payload: fail open
  }
  const timeout = new Promise<HookDecision>((done) => setTimeout(() => done({ kind: 'none' }), BUDGET_MS));
  const decision = await Promise.race([runHook(input).catch((): HookDecision => ({ kind: 'none' })), timeout]);
  let output = '';
  if (decision.kind === 'deny') {
    output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } });
  } else if (decision.kind === 'context') {
    output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: decision.text } });
  }
  // Answer, then exit: in-flight requests must not keep the agent waiting.
  process.stdout.write(output, () => process.exit(0));
  return new Promise<number>(() => {});
}
