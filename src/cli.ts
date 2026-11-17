import { checkMany, type CheckResult } from './check.ts';
import { c, renderHeader, renderInstall, renderResults, installCommand, pinned } from './format.ts';
import { loadGuides, search } from './knowledge.ts';
import { netOptions } from './net.ts';
import { detectEcosystem, detectPackageManager, exemptHint, resolveCooldown } from './project.ts';
import type { Ecosystem } from './registry.ts';
import { VERSION } from './version.ts';
import { installable } from './check.ts';

const HELP = `
  ${c.bold('package-guidance')} ${c.gray(`v${VERSION}`)}
  Pick the right package, the newest settled version, and never install a hallucinated one.

  ${c.bold('Usage')}
    package-guidance check <pkg[@range]>...   Verdict + pinned install line for each package
    package-guidance scan [dir]               Audit package.json / pyproject.toml / requirements.txt
    package-guidance guide [id | query]       List, search, or print curated migration guides
    package-guidance harden [dir] [--write]   Configure a release-age cooldown for this repo
    package-guidance hook                     Claude Code PreToolUse hook (reads JSON on stdin)

  ${c.bold('Options')}
    --pypi | --npm        Ecosystem (default: detected from the project, else npm)
    --cooldown <days>     Minimum release age before a version is "settled" (default 7, or the repo's config)
    --json                Machine-readable output
    --cwd <dir>           Project directory (default: current)
    --no-cache            Skip the 1h on-disk cache
    -v, --verbose         Show every advisory and note
    --all                 scan: also list dependencies that are ok
    --write               harden: apply the change (otherwise only shows it)
    --pm <name>           Package manager (default: detected)

  ${c.bold('Exit codes')}
    0 ok · 1 something is blocked · 2 usage error · 3 error · 4 could not verify (registry or advisory lookup failed)

  ${c.bold('Examples')}
    npx package-guidance check react tailwindcss@3 moment
    npx package-guidance check --pypi "pydantic<2" fastapi
    npx package-guidance guide tailwind
`;

export interface Args { _: string[]; flags: Record<string, string | boolean>; errors?: string[] }

export const EXIT = { ok: 0, blocked: 1, usage: 2, error: 3, unverified: 4 } as const;

const BOOLEAN_FLAGS = ['json', 'no-cache', 'verbose', 'help', 'version', 'all', 'write', 'pypi', 'npm'];
const VALUED_FLAGS = ['cooldown', 'cwd', 'pm'];
const PMS = ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'uv', 'poetry'];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}

const closest = (k: string) => [...BOOLEAN_FLAGS, ...VALUED_FLAGS].map((f) => [f, distance(k, f)] as const).sort((a, b) => a[1] - b[1])[0]!;

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, errors: [] };
  const err = (m: string) => out.errors!.push(m);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const v = eq === -1 ? undefined : a.slice(eq + 1);
      if (VALUED_FLAGS.includes(k)) {
        if (v !== undefined) out.flags[k] = v;
        else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) out.flags[k] = argv[++i]!;
        else err(`--${k} needs a value.`);
      } else if (BOOLEAN_FLAGS.includes(k)) {
        if (v === undefined || /^(true|1|yes)$/i.test(v)) out.flags[k] = true;
        else if (/^(false|0|no)$/i.test(v)) out.flags[k] = false;
        else err(`--${k} takes no value (got "${v}").`);
      } else {
        const [best, d] = closest(k);
        err(`Unknown option --${k}.${d <= 2 ? ` Did you mean --${best}?` : ''}`);
      }
    } else if (a === '-v') out.flags.verbose = true;
    else if (a === '-h') out.flags.help = true;
    else if (/^-[A-Za-z]/.test(a)) err(`Unknown option ${a}.`);
    else out._.push(a);
  }
  if (typeof out.flags.pm === 'string' && !PMS.includes(out.flags.pm)) err(`Unknown package manager "${out.flags.pm}" (one of ${PMS.join(', ')}).`);
  return out;
}

/** Report a usage problem on stderr, and as JSON on stdout when --json was asked for. */
export function fail(args: Args, message: string, code: number = EXIT.usage): number {
  process.stderr.write(`${message}\n`);
  if (args.flags.json) process.stdout.write(JSON.stringify({ tool: 'package-guidance', version: VERSION, error: message, exitCode: code }, null, 2) + '\n');
  return code;
}

/** 1 when something is blocked; otherwise 4 when anything could not be verified (registry or OSV failure). */
export function exitFor(results: CheckResult[]): number {
  if (results.some((r) => r.severity === 'block')) return EXIT.blocked;
  if (results.some((r) => r.unverified || r.verdict === 'error')) return EXIT.unverified;
  return EXIT.ok;
}

function context(args: Args) {
  const cwd = typeof args.flags.cwd === 'string' ? args.flags.cwd : process.cwd();
  const eco: Ecosystem = args.flags.pypi ? 'pypi' : args.flags.npm ? 'npm' : detectEcosystem(cwd);
  return contextFor(args, cwd, eco);
}

export function contextFor(args: Args, cwd: string, eco: Ecosystem) {
  const pm = (typeof args.flags.pm === 'string' ? args.flags.pm : detectPackageManager(cwd, eco)) as ReturnType<typeof detectPackageManager>;
  const cooldown = resolveCooldown(cwd, eco, typeof args.flags.cooldown === 'string' ? args.flags.cooldown : undefined, pm);
  return { cwd, eco, cooldown, pm };
}

/** Only when the repo enforces its own cooldown does a fresh security fix need an explicit exemption. */
export const exemptFor = (meta: { cooldown: { configured: boolean }; pm: Parameters<typeof exemptHint>[0] }) =>
  meta.cooldown.configured ? (name: string, version: string) => exemptHint(meta.pm, name, version) : undefined;

export function toJSON(results: CheckResult[], meta: ReturnType<typeof context>) {
  const specs = [...new Set(results.filter(installable).map((r) => pinned(meta.eco, r)))];
  return {
    tool: 'package-guidance',
    version: VERSION,
    ecosystem: meta.eco,
    cooldown: { days: meta.cooldown.days, source: meta.cooldown.source },
    packageManager: meta.pm,
    install: installCommand(meta.pm, specs) || null,
    blocked: results.filter((r) => r.severity === 'block' && !installable(r)).map((r) => r.name),
    unverified: results.filter((r) => r.unverified).map((r) => r.name),
    unchecked: results.filter((r) => r.verdict === 'error').map((r) => r.name),
    exitCode: exitFor(results),
    results,
  };
}

async function cmdCheck(args: Args): Promise<number> {
  const specs = args._;
  if (!specs.length) return fail(args, 'Usage: package-guidance check <pkg[@range]>...');
  const meta = context(args);
  const results = await checkMany(specs, { ecosystem: meta.eco, cooldownDays: meta.cooldown.days, cooldownSource: meta.cooldown.source, exemptFresh: exemptFor(meta) });
  if (args.flags.json) {
    process.stdout.write(JSON.stringify(toJSON(results, meta), null, 2) + '\n');
  } else {
    process.stdout.write(renderHeader(meta.eco, meta.cooldown.days, meta.cooldown.source) + '\n');
    process.stdout.write(renderResults(results, { pm: meta.pm, verbose: !!args.flags.verbose }));
    process.stdout.write(renderInstall(results, meta.pm) + '\n');
  }
  return exitFor(results);
}

function cmdGuide(args: Args): number {
  const q = args._.join(' ').trim();
  const guides = loadGuides();
  const json = !!args.flags.json;
  if (!q) {
    if (json) { process.stdout.write(JSON.stringify(guides.map(({ id, title }) => ({ id, title })), null, 2) + '\n'); return 0; }
    process.stdout.write(`\n  ${c.bold('Guides')}  ${c.gray('package-guidance guide <id>')}\n\n`);
    const w = Math.max(...guides.map((g) => g.id.length), 4) + 2;
    for (const g of guides) process.stdout.write(`  ${g.id.padEnd(w)}${c.gray(g.title)}\n`);
    process.stdout.write('\n');
    return 0;
  }
  const exact = guides.find((g) => g.id === q);
  if (exact) { process.stdout.write(json ? JSON.stringify(exact) + '\n' : exact.body.trimEnd() + '\n'); return 0; }
  const hits = search(q);
  if (json) {
    process.stdout.write(JSON.stringify({ guides: hits.guides.slice(0, 5).map(({ id, title }) => ({ id, title })), entries: hits.entries.slice(0, 10) }, null, 2) + '\n');
    return 0;
  }
  if (hits.guides.length === 1 && !hits.entries.length) { process.stdout.write(hits.guides[0]!.body.trimEnd() + '\n'); return 0; }
  if (!hits.guides.length && !hits.entries.length) { process.stdout.write(`No guidance found for "${q}".\n`); return 1; }
  process.stdout.write('\n');
  for (const g of hits.guides.slice(0, 5)) process.stdout.write(`  ${c.bold(g.id)}  ${c.gray(g.title)}\n`);
  if (hits.entries.length) process.stdout.write('\n');
  for (const e of hits.entries.slice(0, 8)) {
    process.stdout.write(`  ${c.cyan(e.packages.join(', '))} ${c.gray(e.versions !== '*' ? e.versions : '')}  ${e.summary}${e.replacements.length ? c.gray(` → ${e.replacements.map((r) => r.name).join(', ')}`) : ''}\n`);
  }
  process.stdout.write(`\n  ${c.gray('Print one with: package-guidance guide <id>')}\n\n`);
  return 0;
}

let pipeGuard = false;

export async function main(argv: string[]): Promise<number> {
  if (!pipeGuard) {
    pipeGuard = true;
    // `… | head` closes stdout early; that is the reader's choice, not an error.
    process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0); else throw e; });
  }
  const args = parseArgs(argv);
  if (args.flags['no-cache']) netOptions.cache = false;
  const cmd = args._.shift();
  if (args.errors?.length) return fail(args, `${args.errors.join('\n')}\nRun package-guidance --help`);
  if (args.flags.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (!cmd || args.flags.help || cmd === 'help') { process.stdout.write(HELP + '\n'); return 0; }
  switch (cmd) {
    case 'check': return cmdCheck(args);
    case 'guide': case 'guides': return cmdGuide(args);
    case 'scan':
    case 'harden': {
      // `scan [dir]` / `harden [dir]`: everything (ecosystem, package manager, cooldown) is detected from that dir.
      if (args._[0] && args.flags.cwd === undefined) args.flags.cwd = args._[0];
      const run = cmd === 'scan' ? (await import('./scan.ts')).cmdScan : (await import('./harden.ts')).cmdHarden;
      return run(args, context(args));
    }
    case 'hook': return (await import('./hook.ts')).cmdHook();
    default:
      return fail(args, `Unknown command "${cmd}". Run package-guidance --help`);
  }
}

export type Meta = ReturnType<typeof context>;
