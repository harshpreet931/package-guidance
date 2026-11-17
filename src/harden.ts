/**
 * `harden`: make the package manager itself enforce a release-age cooldown, so the policy holds for every
 * install (people, CI, agents) and not only for agents that run this tool.
 *
 * Facts per package manager (file, key, unit, minimum version) come from data/cooldown.json, which cites
 * the official docs. Rules: never lower an existing value; only write with --write; never write a second
 * key or table; touch one line and keep every other byte (including line endings) as it was.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Args, Meta } from './cli.ts';
import { EXIT, fail } from './cli.ts';
import { c, type PackageManager } from './format.ts';
import { ROOT } from './knowledge.ts';
import { DEFAULT_COOLDOWN_DAYS, SETTINGS, durationDays, findSetting, settingDays, tableName, type Setting } from './project.ts';
import type { Ecosystem } from './registry.ts';
import { compare, parse } from './semver.ts';
import { VERSION } from './version.ts';

interface ManagerFacts {
  config_file: string;
  config_format: 'ini' | 'yaml' | 'toml';
  section?: string;
  key: string;
  min_version: string;
  default_enabled: boolean;
  default_enabled_since?: string;
  cli_flag: string | null;
  env: string | null;
  source: string;
}

export interface Edit { file: string; section: string | null; line: string; create: boolean; format?: Setting['format'] }

function facts(pm: PackageManager): ManagerFacts | null {
  try {
    const data = JSON.parse(readFileSync(join(ROOT, 'data', 'cooldown.json'), 'utf8')) as { managers: Record<string, ManagerFacts & { supported: boolean }> };
    const f = data.managers[pm];
    return f?.supported ? f : null;
  } catch {
    return null;
  }
}

/** The value that sets a `days` cooldown, in the manager's own unit and syntax. */
export function settingValue(pm: PackageManager, days: number): string {
  switch (pm) {
    case 'npm': return `${Math.ceil(days)}`;
    case 'pnpm': return `${Math.round(days * 1440)}`;
    case 'yarn': return `${Math.round(days * 1440)}`; // integer minutes also works on Yarn 4.10.x
    case 'bun': return `${Math.round(days * 86_400)}`;
    case 'uv': return `"${Math.ceil(days)} days"`;
    case 'poetry': return `${Math.ceil(days)}`;
    case 'pip': return `P${Math.ceil(days)}D`;
  }
}

/** The config line that sets a `days` cooldown. */
export function settingLine(pm: PackageManager, days: number): string {
  const v = settingValue(pm, days);
  switch (pm) {
    case 'npm': return `min-release-age=${v}`;
    case 'pnpm': return `minimumReleaseAge: ${v}`;
    case 'yarn': return `npmMinimalAgeGate: ${v}`;
    case 'bun': return `minimumReleaseAge = ${v}`;
    case 'uv': return `exclude-newer = ${v}`;
    case 'poetry': return `min-release-age = ${v}`;
    case 'pip': return `uploaded-prior-to = ${v}`;
  }
}

/** Lockfiles / workspace files that mark the directory whose config the package manager reads. */
const ROOT_MARKERS: Record<PackageManager, string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-workspace.yaml', 'pnpm-lock.yaml'], yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'], uv: ['uv.lock'], poetry: ['poetry.lock'], pip: [],
};

const readText = (p: string) => {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
};

/**
 * The directory whose config applies to `dir`: `dir` itself, or the workspace root above it. Only a real
 * workspace root counts (pnpm-workspace.yaml, a package.json with `workspaces`, `[tool.uv.workspace]`), so a
 * stray lockfile in a home directory never redirects the write.
 */
export function projectRoot(pm: PackageManager, dir: string): string {
  const start = resolve(dir);
  if (ROOT_MARKERS[pm].some((f) => existsSync(join(start, f)))) return start;
  for (let d = dirname(start); ; d = dirname(d)) {
    if (pm === 'pnpm' && existsSync(join(d, 'pnpm-workspace.yaml'))) return d;
    if ((pm === 'npm' || pm === 'yarn' || pm === 'bun') && /"workspaces"\s*:/.test(readText(join(d, 'package.json')) ?? '')) return d;
    if (pm === 'uv' && /^\s*\[\s*tool\.uv\.workspace\s*\]/m.test(readText(join(d, 'pyproject.toml')) ?? '')) return d;
    if (dirname(d) === d) return start;
  }
}

/** Is there a project of this ecosystem in `dir` at all? Without one, harden writes nothing. */
export function hasProject(dir: string, eco: Ecosystem): boolean {
  if (eco === 'npm') return existsSync(join(dir, 'package.json'));
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return false; }
  return names.some((n) => /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|uv\.lock|poetry\.lock|requirements[\w.-]*\.(txt|in))$/.test(n));
}

const HEADER = /^\s*\[(\[)?\s*([^[\]]+?)\s*\]\]?\s*(?:[#;].*)?$/;

/**
 * Insert `line` under `[section]`, or at top level (before the first table in TOML, where a top-level key
 * must go). Creates the section only when it does not exist. Keeps the file's line endings.
 */
export function applyEdit(text: string, edit: Pick<Edit, 'section' | 'line'> & { format?: Setting['format'] }): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = text === '' || text.endsWith('\n') ? text : `${text}${eol}`;
  const lines = body.split('\n');
  const insertAt = (i: number) => {
    lines.splice(i, 0, `${edit.line}${eol === '\r\n' ? '\r' : ''}`);
    return lines.join('\n');
  };
  const header = (l: string) => HEADER.exec(l.replace(/\r$/, ''));
  if (!edit.section) {
    const first = edit.format === 'toml' ? lines.findIndex((l) => header(l)) : -1;
    return first === -1 ? `${body}${edit.line}${eol}` : insertAt(first);
  }
  const at = lines.findIndex((l) => {
    const h = header(l);
    return !!h && !h[1] && tableName(h[2]!) === edit.section;
  });
  if (at === -1) return `${body}${body ? eol : ''}[${edit.section}]${eol}${edit.line}${eol}`;
  return insertAt(at + 1);
}

/** Which of the manager's settings applies in `root` (uv: uv.toml wins over pyproject.toml when present). */
function settingFor(pm: PackageManager, root: string): Setting | null {
  const own = SETTINGS.filter((s) => s.pm === pm);
  return own.find((s) => existsSync(join(root, s.file))) ?? own[own.length - 1] ?? null;
}

/** Where the line goes. `null` for pip, which has no project-level config file. */
export function planEdit(pm: PackageManager, dir: string, days: number): Edit | null {
  const s = pm === 'pip' ? null : settingFor(pm, dir);
  if (!s) return null;
  const file = join(dir, s.file);
  return { file, section: s.section, line: settingLine(pm, days), create: !existsSync(file), format: s.format };
}

function installedVersion(pm: PackageManager): string | null {
  const r = spawnSync(pm, ['--version'], { encoding: 'utf8', timeout: 5000, shell: process.platform === 'win32' });
  const out = `${r.stdout ?? ''}`.trim();
  return /(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] ?? null;
}

export async function cmdHarden(args: Args, meta: Meta): Promise<number> {
  const pm = meta.pm;
  let wanted = DEFAULT_COOLDOWN_DAYS;
  if (args.flags.cooldown !== undefined) {
    const d = typeof args.flags.cooldown === 'string' ? durationDays(args.flags.cooldown, 'days') : null;
    if (d === null || !(d > 0)) return fail(args, `--cooldown must be a positive duration such as 7, 7d or "2 weeks" (got "${args.flags.cooldown}").`);
    wanted = d;
  }
  const json = !!args.flags.json;
  const lines: string[] = [];
  const out = (s = '') => lines.push(s);
  const finish = (status: string, code: number, extra: Record<string, unknown> = {}) => {
    if (json) process.stdout.write(JSON.stringify({ tool: 'package-guidance', version: VERSION, packageManager: pm, targetDays: wanted, status, exitCode: code, ...extra }, null, 2) + '\n');
    else process.stdout.write(lines.map((l) => `${l}\n`).join(''));
    return code;
  };
  out(`\n  ${c.bold('package-guidance harden')}  ${c.gray(`${pm} · target ${wanted}d release-age cooldown`)}\n`);

  const f = facts(pm);
  if (!f) {
    out(`  ${c.yellow('!')} No release-age setting is known for ${pm}. Use package-guidance's check before installing instead.\n`);
    return finish('unsupported', EXIT.ok);
  }

  const root = projectRoot(pm, meta.cwd);
  if (!hasProject(root, meta.eco)) {
    out(`  ${c.yellow('!')} No ${meta.eco === 'npm' ? 'package.json' : 'Python project'} in ${root}; nothing to harden.\n`);
    return finish('no-project', EXIT.usage, { root });
  }

  if (pm === 'pip') {
    out(`  pip has no project-level config. Enforce it per environment instead:`);
    out(`    ${c.cyan(`export ${f.env}=P${Math.ceil(wanted)}D`)}            ${c.gray('# or in CI')}`);
    out(`    ${c.cyan(`pip install --uploaded-prior-to P${Math.ceil(wanted)}D <pkg>`)}`);
    out(`  ${c.gray(`Needs pip ${f.min_version}+. Consider uv, which supports a per-project cooldown.`)}`);
    out(`  ${c.gray(f.source)}\n`);
    return finish('manual', EXIT.ok);
  }

  const setting = settingFor(pm, root)!;
  const file = join(root, setting.file);
  const rel = relative(process.cwd(), file);
  const shown = !rel || rel.startsWith('..') ? file : rel;
  const where = setting.section ? `[${setting.section}] in ${shown}` : shown;
  const before = readText(file);
  const found = findSetting(before, setting.format, setting.section, setting.key);
  const parsed = found && settingDays(setting, found.value);
  const target = settingLine(pm, wanted);

  if (found && parsed && parsed.days >= wanted) {
    out(`  ${c.green('✓')} Already enforced: ${parsed.days}d via ${setting.key} in ${where}.\n`);
    return finish('enforced', EXIT.ok, { file, days: parsed.days });
  }
  if (found && (!parsed || parsed.fixedDate)) {
    // `false`, an env placeholder, a fixed date or a form we can't read: the repo chose it; don't second-guess.
    out(`  ${c.yellow('!')} ${where} sets ${setting.key} to ${found.value}, which package-guidance leaves alone.`);
    out(`    To enforce a ${wanted}d cooldown, set it to: ${c.cyan(target)}\n`);
    return finish('unreadable', EXIT.ok, { file, value: found.value });
  }

  const version = installedVersion(pm);
  const v = version && parse(version);
  const min = parse(f.min_version)!;
  if (!version) out(`  ${c.gray(`Could not run \`${pm} --version\`; the setting needs ${pm} ${f.min_version}+.`)}`);
  else if (v && compare(v, min) < 0) out(`  ${c.yellow('!')} ${pm} ${version} is installed; this setting needs ${f.min_version}+ and is ignored by older versions. Upgrade ${pm}.`);
  if (f.default_enabled && f.default_enabled_since) out(`  ${c.gray(`${pm} ${f.default_enabled_since}+ already holds new releases for 1 day by default; ${wanted}d covers the windows real attacks have used.`)}`);

  if (setting.format === 'yaml' && /^\s*(#.*\n\s*)*\{/.test(before ?? '')) {
    out(`  ${c.yellow('!')} ${shown} uses flow-style YAML, which package-guidance won't rewrite. Add: ${c.cyan(target)}\n`);
    return finish('unsupported-format', EXIT.ok, { file });
  }

  // Raise an existing, smaller value in place (only its value changes); otherwise add one line.
  const after = found ? `${before!.slice(0, found.start)}${settingValue(pm, wanted)}${before!.slice(found.end)}` : applyEdit(before ?? '', { section: setting.section, line: target, format: setting.format });
  if (!args.flags.write) {
    out(found ? `  ${setting.key} in ${c.bold(where)} is ${parsed!.days}d. Raise it to:\n` : `  Add to ${c.bold(where)}${before === null ? c.gray(' (new file)') : ''}:\n`);
    out(`    ${c.cyan(target)}\n`);
    out(`  ${c.gray(`Run again with --write to apply. Source: ${f.source}`)}\n`);
    return finish(found ? 'would-raise' : 'would-add', EXIT.ok, { file, line: target });
  }
  try {
    writeFileSync(file, after);
  } catch (e) {
    out(`  ${c.red('✗')} Could not write ${shown}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. Add this line yourself: ${c.cyan(target)}\n`);
    return finish('write-failed', EXIT.error, { file, line: target });
  }
  out(`  ${c.green('✓')} ${found ? `Raised ${setting.key} to ${settingValue(pm, wanted)} in` : `Wrote ${c.cyan(target)} to`} ${where}.`);
  out(`  ${c.gray('Commit it so every install, by people, CI and agents, waits for releases to settle.')}\n`);
  return finish(found ? 'raised' : 'added', EXIT.ok, { file, line: target });
}
