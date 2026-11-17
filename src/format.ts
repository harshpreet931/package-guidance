import type { CheckResult, Verdict } from './check.ts';
import { installable } from './check.ts';
import type { Ecosystem } from './registry.ts';
import { shellQuote } from './shell.ts';

const colorOn = (() => {
  if ('NO_COLOR' in process.env) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return !!process.stdout.isTTY && process.env.TERM !== 'dumb';
})();

const wrap = (open: number, close: number) => (s: string) => (colorOn ? `\x1b[${open}m${s}\x1b[${close}m` : s);
export const c = {
  bold: wrap(1, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};

const ICON: Record<Verdict, string> = {
  ok: c.green('✓'), caution: c.yellow('!'), outdated: c.yellow('!'), young: c.yellow('!'), unproven: c.yellow('!'), replace: c.cyan('→'), deprecated: c.red('✗'), vulnerable: c.red('✗'),
  malicious: c.red('✗'), 'not-found': c.red('✗'), error: c.gray('?'),
};
const VCOLOR: Record<Verdict, (s: string) => string> = {
  ok: c.green, caution: c.yellow, outdated: c.yellow, young: c.yellow, unproven: c.yellow, replace: c.cyan, deprecated: c.red, vulnerable: c.red, malicious: c.red, 'not-found': c.red, error: c.gray,
};

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(2, n - visible(s)));

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'poetry';

export function installCommand(pm: PackageManager, specs: string[]): string {
  if (!specs.length) return '';
  const args = specs.map(shellQuote).join(' ');
  switch (pm) {
    case 'npm': return `npm install ${args}`;
    case 'pnpm': return `pnpm add ${args}`;
    case 'yarn': return `yarn add ${args}`;
    case 'bun': return `bun add ${args}`;
    case 'uv': return `uv add ${args}`;
    case 'poetry': return `poetry add ${args}`;
    case 'pip': return `pip install ${args}`;
  }
}

export const pinned = (eco: Ecosystem, r: CheckResult) => (eco === 'npm' ? `${r.name}@${r.version}` : `${r.name}==${r.version}`);

export function renderHeader(eco: Ecosystem, cooldownDays: number, cooldownSource: string): string {
  const src = cooldownSource === 'default' ? '' : c.gray(` (${cooldownSource})`);
  return `\n  ${c.bold('package-guidance')}  ${c.gray(`${eco} · cooldown ${cooldownDays}d`)}${src}\n`;
}

/** As many whole sentences as fit a terminal line (at least one, truncated if it must be). Full text: -v / --json. */
export function headline(text: string, max = 110): string {
  // A sentence ends at . ! ? followed by whitespace and a capital, digit or quote, so `4.3.x` and `e.g.` stay intact.
  const sentences = text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(])/);
  let out = sentences[0] ?? text;
  for (const next of sentences.slice(1)) {
    if (out.length + 1 + next.length > max) break;
    out += ` ${next}`;
  }
  if (out.length <= max) return out;
  const cut = out.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
}

export function renderResults(results: CheckResult[], opts: { pm: PackageManager; verbose?: boolean; label?: (r: CheckResult) => string } = { pm: 'npm' }): string {
  const label = opts.label ?? ((r: CheckResult) => r.requested);
  const w1 = Math.min(28, Math.max(...results.map((r) => visible(label(r))), 8)) + 2;
  const w2 = Math.max(...results.map((r) => r.verdict.length), 2) + 3;
  const indent = ' '.repeat(4 + w1 + w2);
  // Fit the terminal (100 columns when piped); -v prints everything in full.
  const room = Math.max(48, (process.stdout.columns || Number(process.env.COLUMNS) || 100) - indent.length - 1);
  const short = (t: string) => (opts.verbose ? t : headline(t, room));
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`  ${ICON[r.verdict]} ${pad(c.bold(label(r)), w1)}${pad(VCOLOR[r.verdict](r.verdict), w2)}${short(r.message)}`);
    const detail: string[] = [];
    if (r.alternatives.length && r.verdict !== 'ok' && r.fixedIn === null) detail.push(`use ${r.alternatives.slice(0, 3).join(', ')}`);
    if (r.guide) detail.push(`guide: ${r.guide}`);
    if (detail.length) lines.push(`${indent}${c.cyan(detail.join(' · '))}`);
    if (r.verdict !== 'ok' || opts.verbose) {
      for (const a of r.advisories.slice(0, opts.verbose ? 20 : 2)) lines.push(`${indent}${c.gray(`${a.severity.padEnd(8)} ${a.id}  ${short(a.summary)}`)}`);
      if (!opts.verbose && r.advisories.length > 2) lines.push(`${indent}${c.gray(`+${r.advisories.length - 2} more (-v)`)}`);
    }
    for (const n of r.notes.slice(0, opts.verbose ? 20 : 1)) lines.push(`${indent}${c.gray(short(n))}`);
  }
  return lines.join('\n') + '\n';
}

export function renderInstall(results: CheckResult[], pm: PackageManager): string {
  const eco: Ecosystem = pm === 'npm' || pm === 'pnpm' || pm === 'yarn' || pm === 'bun' ? 'npm' : 'pypi';
  const specs = [...new Set(results.filter(installable).map((r) => pinned(eco, r)))];
  const blocked = results.filter((r) => r.severity === 'block' && !installable(r));
  let out = '';
  if (specs.length) out += `\n  ${c.bold('Install')}  ${installCommand(pm, specs)}\n`;
  const unverified = results.filter((r) => r.unverified && installable(r));
  if (unverified.length) out += `  ${c.yellow('Unverified')}  ${unverified.map((r) => r.name).join(', ')}${c.gray("  the advisory lookup failed; run your package manager's audit after installing")}\n`;
  const hint = blocked.some((r) => r.alternatives.length) ? 'do not install; use the alternatives above' : 'do not install';
  if (blocked.length) out += `\n  ${c.red('Blocked')}  ${blocked.map((r) => r.name).join(', ')}${c.gray(`  ${hint}`)}\n`;
  const unchecked = results.filter((r) => r.verdict === 'error');
  if (unchecked.length) out += `\n  ${c.yellow('Not checked')}  ${unchecked.map((r) => r.name).join(', ')}${c.gray('  verify these manually')}\n`;
  return out;
}
