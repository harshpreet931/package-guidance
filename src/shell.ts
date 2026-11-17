/**
 * Find package installs in a shell command line, e.g.
 *   `cd app && npm i -D vitest@^3 > log.txt && npx create-react-app web`
 *     → npm add [vitest@^3]   ·   npm exec [create-react-app]
 *
 * The hook can deny commands based on this, and a wrong deny is the most expensive mistake the tool can make,
 * so the parser is conservative. Every spec carries a `confident` flag. It is only true when the token is
 * unambiguously a package argument: not the possible value of a flag we do not know, not inside a heredoc or
 * comment, and not a redirect target. Consumers must treat low-confidence specs as hints, never as grounds to block.
 */
import type { PackageManager } from './format.ts';
import type { Ecosystem } from './registry.ts';

export interface Spec {
  /** The spec to check, e.g. `react@^19`, `pydantic[email]<2`, or `lodash@4.17.21` for an `alias@npm:lodash@4.17.21`. */
  spec: string;
  /** Index of the original token in `Install.words`, for rewriting the command. */
  index: number;
  confident: boolean;
  /** The argument as typed (`vite@5` for `npm create vite@5`), which a pinned token replaces. */
  raw: string;
  /** Text before the argument in the same word, e.g. `--package=`. */
  prefix: string;
}

/** Where a word sits in the original command line. `quote` is the quoting the word sits inside (for `bash -c '…'`). */
export interface Span { start: number; end: number; quote: '' | "'" | '"' }

export interface Install {
  ecosystem: Ecosystem;
  pm: PackageManager;
  /** `add` installs into the project or environment; `exec` downloads and runs a package once (npx, uvx, create-*). */
  kind: 'add' | 'exec';
  specs: Spec[];
  /** The simple command's words, unquoted (including any env assignments / sudo prefix). */
  words: string[];
  /** Source position of each word in `line`, or null when it cannot be edited in place. */
  spans: (Span | null)[];
  /** The full original command line, which rewrites splice into so everything else stays byte for byte. */
  line: string;
  /** Installs from a non-default registry or index: a 404 on the public registry proves nothing. */
  customRegistry: boolean;
  /** npx/bunx/npm exec run a locally installed binary of this name if there is one, without downloading. */
  localBin: string | null;
  /** `--dry-run`: nothing gets installed. */
  dryRun: boolean;
  /** `npm update x` & co: `range` stays inside the manifest's range, `latest` ignores it (yarn berry `up`, `--latest`). */
  update: 'range' | 'latest' | null;
  /** Subcommand to swap in when pinning, e.g. `npm update x` → `npm install x@1.2.3`: [word index, replacement]. */
  pinSubcommand: [number, string] | null;
}

// ------------------------------------------------------------------ tokenizer

interface Word {
  text: string;
  start: number;
  end: number;
  /** Source index of each character of `text`, and the quoting it came from: u(nquoted), s(ingle), d(ouble). */
  map: number[];
  ctx: string;
}

/**
 * Split a command line into simple commands (on && || ; | & and newlines), unquoting words and keeping their positions.
 * Drops comments, redirects (with their targets) and heredoc bodies, and joins `\`-newline continuations.
 */
function lex(input: string): Word[][] {
  const line = input.replace(/\\\r?\n/g, (m) => ' '.repeat(m.length)); // same length: offsets stay valid for `input`
  const commands: Word[][] = [];
  const heredocs: { delim: string; strip: boolean }[] = [];
  let words: Word[] = [];
  let text = '';
  let map: number[] = [];
  let ctx = '';
  let start = 0;
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let skipNextWord = false; // the target of a redirect
  let pendingHeredoc: { strip: boolean } | null = null;

  const begin = (i: number) => { if (!inWord) { inWord = true; start = i; } };
  const put = (c: string, at: number, q: string) => { text += c; map.push(at); ctx += q; };
  const endWord = (i: number) => {
    if (inWord) {
      if (pendingHeredoc) heredocs.push({ delim: text, ...pendingHeredoc });
      else if (!skipNextWord) words.push({ text, start, end: i, map, ctx });
      skipNextWord = false;
      pendingHeredoc = null;
    }
    text = '';
    map = [];
    ctx = '';
    inWord = false;
  };
  const endCommand = (i: number) => {
    endWord(i);
    if (words.length) commands.push(words);
    words = [];
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`]/.test(line[i + 1] ?? '')) { i++; put(line[i]!, i, 'd'); }
      else put(ch, i, quote === "'" ? 's' : 'd');
      continue;
    }
    if (ch === "'" || ch === '"') { begin(i); quote = ch; continue; }
    if (ch === '\\' && i + 1 < line.length) { begin(i); i++; put(line[i]!, i, 'u'); continue; }
    if (ch === '#' && !inWord) { while (i + 1 < line.length && line[i + 1] !== '\n') i++; continue; }
    // `arr=(npm i x)` is an array assignment, not a subshell: keep it as one word.
    if (ch === '(' && inWord && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(text)) {
      let depth = 0;
      let q: string | null = null;
      for (; i < line.length; i++) {
        const c = line[i]!;
        put(c, i, 'u');
        if (q) { if (c === q) q = null; continue; }
        if (c === "'" || c === '"') q = c;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) break;
      }
      continue;
    }

    // Redirects: [n]>, >>, >|, &>, &>>, <, <<<, [n]>&m, <<(-) heredoc.
    const fdPrefix = inWord && /^\d+$/.test(text) && (ch === '>' || ch === '<');
    if (ch === '>' || ch === '<' || (ch === '&' && line[i + 1] === '>')) {
      if (fdPrefix) { text = ''; map = []; ctx = ''; inWord = false; } else endWord(i);
      if (ch === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        i++;
        const strip = line[i + 1] === '-';
        if (strip) i++;
        pendingHeredoc = { strip };
        continue;
      }
      while (/[<>&|]/.test(line[i + 1] ?? '') && !(line[i + 1] === '&' && /[\s;]/.test(line[i + 2] ?? ' '))) i++;
      if (line[i] === '&' && /[\d-]/.test(line[i + 1] ?? '')) { i++; continue; } // 2>&1, >&-
      skipNextWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(i); continue; }
    if (ch === '\n') {
      endCommand(i);
      // Skip heredoc bodies that start after this line.
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift()!;
        let j = i + 1;
        for (;;) {
          const nl = line.indexOf('\n', j);
          const body = line.slice(j, nl === -1 ? line.length : nl);
          j = nl === -1 ? line.length : nl + 1;
          if ((strip ? body.replace(/^\t+/, '') : body) === delim || nl === -1) break;
        }
        i = j - 1;
      }
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') { endCommand(i); continue; }
    begin(i);
    put(ch, i, 'u');
  }
  endCommand(line.length);
  return commands;
}

/** Simple commands as unquoted words. */
export function tokenize(input: string): string[][] {
  return lex(input).map((c) => c.map((w) => w.text));
}

// ------------------------------------------------------------------ flag tables

/** Per-tool flags: `v` consume the next word, `b` do not, `r` point at another registry or index. Unknown flags make the next positional low-confidence. */
interface Flags { v: Set<string>; b: Set<string>; r: Set<string> }
const set = (s: string) => new Set(s.split(' ').filter(Boolean));
const flags = (v: string, b: string, r = ''): Flags => ({ v: set(v), b: set(b), r: set(r) });

const NPM_COMMON_V = '--registry --tag --cache --userconfig --loglevel --package -p --network-timeout';
const NPM_COMMON_B = '-y --yes -s --silent -q --quiet --verbose --dry-run --force -f --ignore-scripts --offline --prefer-offline --prefer-online -g --global';
const PIP_INDEX = '-i --index-url --extra-index-url -f --find-links --no-index';

type Tool = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'pip' | 'uv' | 'poetry' | 'pipx';
const FLAGS: Record<Tool, Flags> = {
  npm: flags(
    `${NPM_COMMON_V} --prefix -w --workspace --omit --include --save-prefix --call -c --before --os --cpu --libc --location --install-strategy --min-release-age`,
    `${NPM_COMMON_B} -D --save-dev -P --save-prod -O --save-optional -E --save-exact -B --save-bundle -S --save --no-save --save-peer --legacy-peer-deps --strict-peer-deps --no-audit --no-fund --no-package-lock --package-lock-only --install-links --include-workspace-root -ws --workspaces --foreground-scripts --no-bin-links`,
    '--registry',
  ),
  pnpm: flags(
    `${NPM_COMMON_V} -C --dir --filter -F --config --reporter --store-dir --virtual-store-dir --resolution-mode`,
    `${NPM_COMMON_B} -D --save-dev -P --save-prod -O --save-optional -E --save-exact --save-peer -w --workspace-root --workspace -r --recursive --ignore-workspace-root-check --frozen-lockfile --no-frozen-lockfile --prefer-frozen-lockfile --lockfile-only --shamefully-hoist --allow-build -L --latest -i --interactive`,
    '--registry',
  ),
  yarn: flags(
    `${NPM_COMMON_V} --cwd --modules-folder --mode`,
    `${NPM_COMMON_B} -D --dev -P --peer -O --optional -E --exact -T --tilde -C --caret -W --ignore-workspace-root-check -i --interactive --cached --frozen-lockfile --immutable -R --recursive -L --latest`,
    '--registry',
  ),
  bun: flags(
    `${NPM_COMMON_V} --cwd --config -c --backend --cache-dir --cafile --ca --minimum-release-age`,
    `${NPM_COMMON_B} -d -D --dev --development --optional --peer -E --exact --no-save --frozen-lockfile --trust --production -p --latest`,
    '--registry',
  ),
  pip: flags(
    '-r --requirement -c --constraint -e --editable -i --index-url --extra-index-url -f --find-links -t --target --prefix --root --platform --python-version --implementation --abi --only-binary --no-binary --timeout --retries --trusted-host --progress-bar --upgrade-strategy --proxy --cert --client-cert --log --src -C --config-settings --global-option --cache-dir --uploaded-prior-to --python --report',
    '-U --upgrade --user --no-deps --pre --force-reinstall -I --ignore-installed --no-cache-dir --break-system-packages --no-build-isolation --require-hashes --prefer-binary --isolated -q --quiet -v --verbose --dry-run --compile --no-compile --no-index --system --no-warn-script-location --disable-pip-version-check',
    PIP_INDEX,
  ),
  uv: flags(
    '-r --requirements -c --constraints --python -p --group --extra --optional --with --from --index --default-index -i --index-url --extra-index-url -f --find-links --directory --project --package --script -m --marker --branch --tag --rev --python-platform --python-version --exclude-newer --upgrade-package -P --cache-dir --config-file -C --config-setting --target --prefix --index-strategy --resolution --link-mode --only-binary --no-binary -w --with-requirements --with-editable',
    '--dev -U --upgrade --no-sync --frozen --locked --raw --raw-sources --editable --no-editable --system --break-system-packages --pre --prerelease --no-deps -q --quiet -v --verbose --offline --no-cache -n --native-tls --compile-bytecode --force --reinstall --dry-run --no-build-isolation --active --isolated --no-config --refresh --all-extras --no-workspace --workspace --no-index',
    `--index --default-index ${PIP_INDEX}`,
  ),
  poetry: flags(
    '-G --group -E --extras --source --python --platform -C --directory -P --project --markers',
    '-D --dev -e --editable --optional --allow-prereleases --dry-run --lock -q --quiet -v -vv -vvv --verbose -n --no-interaction --no-ansi --ansi',
    '--source',
  ),
  pipx: flags(
    '--python --pip-args --index-url -i --suffix --spec --preinstall',
    '--force -f --include-deps --system-site-packages --editable -e --global -q --quiet -v --verbose --fetch-missing-python --no-cache',
    '--index-url -i --pip-args',
  ),
};

/** npm-style per-scope registry flag, e.g. `--@acme:registry=https://npm.acme.dev`. */
const SCOPE_REGISTRY_FLAG = /^--@[^:\s=]+:registry$/;

interface Positional { text: string; index: number; confident: boolean; prefix?: string }

/** Walk args after the subcommand; returns positionals, and whether a custom registry/index was given. */
function scanArgs(words: string[], start: number, table: Flags): { positionals: Positional[]; customRegistry: boolean } {
  const positionals: Positional[] = [];
  let customRegistry = false;
  let afterUnknownFlag = false;
  for (let i = start; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') break; // everything after belongs to the executed program
    if (w.startsWith('-') && w.length > 1) {
      const name = w.includes('=') ? w.slice(0, w.indexOf('=')) : w;
      const scoped = SCOPE_REGISTRY_FLAG.test(name);
      if (table.r.has(name) || (scoped && table.r.has('--registry'))) customRegistry = true;
      if (w.includes('=') || table.b.has(name)) { afterUnknownFlag = false; continue; }
      if (table.v.has(name) || scoped) { i++; afterUnknownFlag = false; continue; }
      afterUnknownFlag = true; // might take a value: the next positional is ambiguous
      continue;
    }
    positionals.push({ text: w, index: i, confident: !afterUnknownFlag });
    afterUnknownFlag = false;
  }
  return { positionals, customRegistry };
}

/**
 * npx / npm exec / bunx / dlx. `-p`/`--package` given before the first positional name the packages, and that
 * positional is then just the binary. Without them the first positional is both package and binary. Anything after
 * the first positional (or `--`) belongs to the program: `npx tsc -p tsconfig.json`.
 */
function scanExec(words: string[], start: number, table: Flags, skip = -1): { packages: Positional[]; bin: Positional | null; customRegistry: boolean } {
  const packages: Positional[] = [];
  let customRegistry = false;
  let afterUnknownFlag = false;
  for (let i = start; i < words.length; i++) {
    if (i === skip) continue;
    const w = words[i]!;
    if (w === '--') {
      const next = words[i + 1];
      // `npm exec -- tsc` usually runs a local binary; never grounds to deny.
      return { packages, bin: next === undefined ? null : { text: next, index: i + 1, confident: false }, customRegistry };
    }
    if (w === '-p' || w === '--package') {
      if (words[i + 1] !== undefined) packages.push({ text: words[i + 1]!, index: i + 1, confident: true });
      i++;
      continue;
    }
    const pkgEq = /^(?:-p|--package)=(.+)$/.exec(w);
    if (pkgEq) { packages.push({ text: pkgEq[1]!, index: i, confident: true, prefix: w.slice(0, w.indexOf('=') + 1) }); continue; }
    if (w.startsWith('-') && w.length > 1) {
      const name = w.includes('=') ? w.slice(0, w.indexOf('=')) : w;
      const scoped = SCOPE_REGISTRY_FLAG.test(name);
      if (table.r.has(name) || scoped) customRegistry = true;
      if (w.includes('=') || table.b.has(name)) { afterUnknownFlag = false; continue; }
      if (table.v.has(name) || scoped) { i++; afterUnknownFlag = false; continue; }
      afterUnknownFlag = true;
      continue;
    }
    return { packages, bin: { text: w, index: i, confident: !afterUnknownFlag }, customRegistry };
  }
  return { packages, bin: null, customRegistry };
}

// ------------------------------------------------------------------ specs

const PROTOCOL = /^(git\+|git:|github:|gitlab:|bitbucket:|gist:|file:|link:|workspace:|portal:|patch:|catalog:|jsr:|https?:|ssh:)/;
const isLocalish = (s: string) =>
  /^[.~/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s) || s.includes('://') || PROTOCOL.test(s) || /\.(tgz|tar\.gz|tar|whl|zip)$/.test(s) ||
  (s.includes('/') && !s.startsWith('@')); // user/repo is GitHub shorthand

export function npmSpec(word: string): string | null {
  if (!word || isLocalish(word)) return null;
  const at = word.indexOf('@', word.startsWith('@') ? 1 : 0);
  const name = at === -1 ? word : word.slice(0, at);
  const version = at === -1 ? '' : word.slice(at + 1);
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return null;
  if (version.startsWith('npm:')) return npmSpec(version.slice(4)); // alias@npm:real@1.2.3 → real@1.2.3
  if (version && isLocalish(version)) return null; // pkg@workspace:*, pkg@file:../x, pkg@github:a/b
  return word;
}

const PY_NAME = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._ -]*\])?`;

/** A PEP 508 requirement. With `allowAt`, also poetry/uvx `name@constraint` (`ruff@0.6.0`, `requests@^2`, `x@latest`). */
export function pySpec(word: string, allowAt = false): string | null {
  if (!word || isLocalish(word)) return null;
  if (allowAt) {
    const m = new RegExp(`^${PY_NAME}@([\\^~]?[=<>!~]*[A-Za-z0-9.*+!_,<>=~ -]*)$`).exec(word);
    if (m && m[2]!.trim()) return word.trim();
  }
  if (/\s@\s|^[^=<>!~]*@/.test(word)) return null; // pkg @ https://… direct references
  const ok = new RegExp(String.raw`^${PY_NAME}\s*((===?|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*(,\s*(===?|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]+\s*)*)?(;.*)?$`);
  return ok.test(word) ? word.replace(/\s*;.*$/, '').trim() : null;
}

/** `create foo` → create-foo · `create @scope` → @scope/create · `create @scope/foo` → @scope/create-foo */
function createPackage(arg: string): string {
  const at = arg.indexOf('@', arg.startsWith('@') ? 1 : 0);
  const base = at === -1 ? arg : arg.slice(0, at);
  const version = at === -1 ? '' : arg.slice(at);
  const pkg = base.startsWith('@') ? (base.includes('/') ? base.replace('/', '/create-') : `${base}/create`) : `create-${base}`;
  return pkg + version;
}

// ------------------------------------------------------------------ command prefixes

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Shell keywords that may precede a simple command: `if ! npm ls x; then npm i x; fi`. */
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

/** Commands that run another command. `v` flags take a value, `skip` leading positionals (timeout's duration), `stop` flags mean nothing runs. */
interface Wrapper { v: Set<string>; skip: number; stop: Set<string> }
const wrapper = (v: string, skip = 0, stop = ''): Wrapper => ({ v: set(v), skip, stop: set(stop) });
const WRAPPERS: Record<string, Wrapper> = {
  sudo: wrapper('-u --user -g --group -C --close-from -D --chdir --host -p --prompt -r --role -t --type -U --other-user -T --command-timeout', 0, '-l --list -v --validate -k -K -e --edit -V --version'),
  doas: wrapper('-u -C'),
  env: wrapper('-u --unset -C --chdir -S --split-string'),
  nice: wrapper('-n --adjustment'),
  nohup: wrapper(''),
  time: wrapper('-f --format -o --output'),
  command: wrapper('', 0, '-v -V'),
  builtin: wrapper(''),
  exec: wrapper('-a'),
  timeout: wrapper('-s --signal -k --kill-after', 1),
  xargs: wrapper('-a --arg-file -d --delimiter -E -I --replace -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var'),
  stdbuf: wrapper('-i --input -o --output -e --error'),
  caffeinate: wrapper('-t -w'),
};

/** Index of the actual command word, past env assignments, shell keywords and wrappers; `words.length` if none runs. */
function commandStart(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (ENV_ASSIGNMENT.test(w) || RESERVED.has(w)) { i++; continue; }
    const wrap = WRAPPERS[w];
    if (!wrap) return i;
    i++;
    let skip = wrap.skip;
    while (i < words.length) {
      const a = words[i]!;
      if (a === '--') { i++; break; }
      if (wrap.stop.has(a)) return words.length;
      if (a.startsWith('-') && a.length > 1) { i += wrap.v.has(a) ? 2 : 1; continue; }
      if (skip > 0) { skip--; i++; continue; }
      break;
    }
  }
  return i;
}

// ------------------------------------------------------------------ registries via environment

const REGISTRY_ENV: Record<Ecosystem, RegExp> = {
  npm: /^(npm_config_registry|npm_config_@.+:registry|yarn_npm_registry_server|yarn_npm_scopes|bun_config_registry)$/i,
  pypi: /^(pip_index_url|pip_extra_index_url|pip_find_links|pip_no_index|uv_index_url|uv_extra_index_url|uv_default_index|uv_index|uv_find_links|uv_no_index|poetry_repositories_.+)$/i,
};
/** The public registries. npm itself exports `npm_config_registry=https://registry.npmjs.org/` to child processes. */
export const isPublicRegistry = (url: string) => /^\s*["']?https?:\/\/(registry\.npmjs\.org|registry\.yarnpkg\.com|pypi\.org|files\.pythonhosted\.org)(\/|["']?\s*$)/i.test(url);
/** An environment variable that points this ecosystem's installs at a non-public registry or index. */
export const privateRegistryVar = (eco: Ecosystem, name: string, value: string | undefined) =>
  REGISTRY_ENV[eco].test(name) && !!value?.trim() && !isPublicRegistry(value);

function envRegistry(commands: string[][]): Record<Ecosystem, boolean> {
  const out: Record<Ecosystem, boolean> = { npm: false, pypi: false };
  for (const w of commands.flat()) {
    const eq = w.indexOf('=');
    if (eq <= 0 || !ENV_ASSIGNMENT.test(w)) continue;
    for (const eco of ['npm', 'pypi'] as const) if (privateRegistryVar(eco, w.slice(0, eq), w.slice(eq + 1))) out[eco] = true;
  }
  return out;
}

// ------------------------------------------------------------------ installs

const NPM_ADD = new Set(['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add']);
const UPDATE = new Set(['update', 'up', 'upgrade', 'udpate']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

type SpanOf = (w: Word) => Span | null;
const topSpan: SpanOf = (w) => ({ start: w.start, end: w.end, quote: '' });

/** Map a word of a `bash -c` script back into the outer line, if it sits contiguously in one quoting context. */
function nestedSpan(outer: Word, outerSpan: Span | null): SpanOf {
  return (w) => {
    if (!outerSpan || outerSpan.quote !== '' || w.end <= w.start) return null;
    const q = outer.ctx[w.start];
    for (let k = w.start; k < w.end; k++) {
      if (outer.ctx[k] !== q || (k > w.start && outer.map[k] !== outer.map[k - 1]! + 1)) return null;
    }
    return { start: outer.map[w.start]!, end: outer.map[w.end - 1]! + 1, quote: q === 's' ? "'" : q === 'd' ? '"' : '' };
  };
}

export function parseInstalls(commandLine: string): Install[] {
  return parseLine(commandLine, lex(commandLine), topSpan, { npm: false, pypi: false }, 0);
}

function parseLine(line: string, commands: Word[][], spanOf: SpanOf, outerEnv: Record<Ecosystem, boolean>, depth: number): Install[] {
  const out: Install[] = [];
  const env = envRegistry(commands.map((c) => c.map((w) => w.text)));
  env.npm ||= outerEnv.npm;
  env.pypi ||= outerEnv.pypi;

  for (const cmdWords of commands) {
    const words = cmdWords.map((w) => w.text);
    const spans = cmdWords.map(spanOf);
    const start = commandStart(words);
    const cmd = (words[start] ?? '').replace(/^.*[\\/]/, '').replace(/\.(cmd|exe)$/i, '');
    if (!cmd) continue;
    const at = start + 1;

    const push = (ecosystem: Ecosystem, pm: PackageManager, kind: Install['kind'], chosen: Positional[], customRegistry: boolean,
      toSpec: (w: string) => string | null, opts: { localBin?: boolean; map?: (w: string) => string; update?: Install['update']; pinSubcommand?: [number, string] } = {}) => {
      const specs: Spec[] = [];
      for (const p of chosen) {
        const s = toSpec(opts.map ? opts.map(p.text) : p.text);
        if (s) specs.push({ spec: s, index: p.index, confident: p.confident, raw: p.text, prefix: p.prefix ?? '' });
      }
      if (!specs.length) return;
      const bin = opts.localBin && specs[0] && !specs[0].spec.slice(1).includes('@') ? specs[0].spec.replace(/^@[^/]+\//, '') : null;
      out.push({
        ecosystem, pm, kind, specs, words, spans, line, customRegistry: customRegistry || env[ecosystem], localBin: bin,
        dryRun: words.includes('--dry-run'), update: opts.update ?? null, pinSubcommand: opts.pinSubcommand ?? null,
      });
    };
    const add = (ecosystem: Ecosystem, pm: PackageManager, kind: Install['kind'], from: number, table: Flags, toSpec: (w: string) => string | null,
      opts: Parameters<typeof push>[6] & { first?: boolean } = {}) => {
      const { positionals, customRegistry } = scanArgs(words, from, table);
      push(ecosystem, pm, kind, opts.first ? positionals.slice(0, 1) : positionals, customRegistry, toSpec, opts);
    };
    const exec = (pm: PackageManager, from: number, table: Flags, skip = -1, localBin = true) => {
      const { packages, bin, customRegistry } = scanExec(words, from, table, skip);
      if (packages.length) push('npm', pm, 'exec', packages, customRegistry, npmSpec);
      else if (bin) push('npm', pm, 'exec', [bin], customRegistry, npmSpec, { localBin });
    };
    /** First positional after the PM, skipping its flags: the subcommand. */
    const sub = (table: Flags) => scanArgs(words, at, table).positionals[0];

    // ---- shells: look inside `bash -c '…'`
    if (SHELLS.has(cmd)) {
      for (let i = at; i < words.length && words[i]!.startsWith('-'); i++) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[i]!) && i + 1 < words.length) {
          if (depth < 2) out.push(...parseLine(line, lex(words[i + 1]!), nestedSpan(cmdWords[i + 1]!, spans[i + 1]!), env, depth + 1));
          break;
        }
      }
      continue;
    }

    // ---- JavaScript
    if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') {
      const pm: PackageManager = cmd === 'bunx' ? 'bun' : cmd === 'pnpx' ? 'pnpm' : 'npm';
      exec(pm, at, FLAGS[pm]);
      continue;
    }
    if (cmd === 'npm' || cmd === 'pnpm' || cmd === 'yarn' || cmd === 'bun') {
      const table = FLAGS[cmd];
      const s = sub(table);
      if (!s) continue;
      const next = s.index + 1;
      if (cmd === 'npm' && NPM_ADD.has(s.text)) add('npm', cmd, 'add', next, table, npmSpec);
      else if ((cmd === 'pnpm' || cmd === 'bun') && ['add', 'a', 'install', 'i'].includes(s.text)) add('npm', cmd, 'add', next, table, npmSpec);
      else if (cmd === 'yarn' && s.text === 'add') add('npm', cmd, 'add', next, table, npmSpec);
      else if (cmd === 'yarn' && s.text === 'global' && words[next] === 'add') add('npm', cmd, 'add', next + 1, table, npmSpec);
      else if (UPDATE.has(s.text) && (cmd !== 'yarn' || s.text === 'up' || s.text === 'upgrade')) {
        const latest = (cmd === 'yarn' && s.text === 'up') || words.some((w, i) => i > s.index && (w === '--latest' || w === '-L'));
        const pinSubcommand: [number, string] | undefined = cmd === 'npm' ? [s.index, 'install'] : cmd === 'bun' ? [s.index, 'add'] : undefined;
        add('npm', cmd, 'add', next, table, npmSpec, { update: latest ? 'latest' : 'range', pinSubcommand });
      } else if (s.text === 'create' || (cmd === 'npm' && (s.text === 'init' || s.text === 'innit'))) {
        add('npm', cmd, 'exec', next, table, npmSpec, { first: true, map: createPackage });
      } else if ((cmd === 'npm' && s.text === 'exec') || (cmd === 'bun' && s.text === 'x')) exec(cmd, at, table, s.index);
      else if ((cmd === 'pnpm' || cmd === 'yarn') && s.text === 'dlx') exec(cmd, at, table, s.index, false);
      // `pnpm exec`, `yarn exec`, `npm run`, `bun run` only run binaries that are already installed.
      continue;
    }

    // ---- Python
    const py = (w: string) => pySpec(w);
    const pyAt = (w: string) => pySpec(w, true);
    if (/^pip(3(\.\d+)?)?$/.test(cmd) || (/^python(3(\.\d+)?)?$/.test(cmd) && words[at] === '-m' && /^pip3?$/.test(words[at + 1] ?? ''))) {
      const from = cmd.startsWith('python') ? at + 2 : at;
      const s = scanArgs(words, from, FLAGS.pip).positionals[0];
      if (s?.text === 'install') add('pypi', 'pip', 'add', s.index + 1, FLAGS.pip, py);
      continue;
    }
    const uvFrom = (fromIdx: number) => {
      const { customRegistry } = scanArgs(words, at, FLAGS.uv);
      push('pypi', 'uv', 'exec', [{ text: words[fromIdx + 1] ?? '', index: fromIdx + 1, confident: true }], customRegistry, pyAt);
    };
    if (cmd === 'uv') {
      const s = sub(FLAGS.uv);
      if (!s) continue;
      if (s.text === 'add') add('pypi', 'uv', 'add', s.index + 1, FLAGS.uv, py);
      else if (s.text === 'pip' && words[s.index + 1] === 'install') add('pypi', 'uv', 'add', s.index + 2, FLAGS.uv, py);
      else if (s.text === 'tool' && (words[s.index + 1] === 'install' || words[s.index + 1] === 'run')) {
        const fromIdx = words.indexOf('--from', s.index);
        if (fromIdx >= 0) uvFrom(fromIdx);
        else add('pypi', 'uv', words[s.index + 1] === 'install' ? 'add' : 'exec', s.index + 2, FLAGS.uv, pyAt, { first: true });
      }
      continue;
    }
    if (cmd === 'uvx') {
      const fromIdx = words.indexOf('--from', at);
      if (fromIdx >= 0) uvFrom(fromIdx);
      else add('pypi', 'uv', 'exec', at, FLAGS.uv, pyAt, { first: true });
      continue;
    }
    if (cmd === 'pipx') {
      const s = sub(FLAGS.pipx);
      if (s?.text === 'install') add('pypi', 'pip', 'add', s.index + 1, FLAGS.pipx, py);
      else if (s?.text === 'run') add('pypi', 'pip', 'exec', s.index + 1, FLAGS.pipx, py, { first: true });
      continue;
    }
    if (cmd === 'poetry') {
      const s = sub(FLAGS.poetry);
      if (s?.text === 'add') add('pypi', 'poetry', 'add', s.index + 1, FLAGS.poetry, pyAt);
    }
  }
  return out;
}

// ------------------------------------------------------------------ rewriting

const SAFE_WORD = /^[A-Za-z0-9_\-+=.,/:@%]+$/;
/** POSIX-shell quote a word only when needed. */
export const shellQuote = (w: string) => (SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** A token written where the original word was: bare, or inside the outer quotes of a `bash -c '…'` script. */
function quoteIn(quote: Span['quote'], token: string): string | null {
  if (quote === '') return shellQuote(token);
  if (SAFE_WORD.test(token)) return token;
  if (/['"$`\\!]/.test(token)) return null;
  return quote === "'" ? `"${token}"` : `'${token}'`;
}

export interface Change { install: Install; replace: Map<number, string | null> }

/**
 * Splice replacements into the original command line, keeping everything else (cd chains, env, quotes, `~`, `$VAR`)
 * byte for byte. `replace` maps a word index to its new token, or to null to drop that argument.
 * Returns null when an edit cannot be made safely; the result is re-parsed to prove each new token lands as a spec.
 */
export function rewriteCommand(changes: Change[]): string | null {
  const line = changes[0]?.install.line;
  if (line === undefined) return null;
  const edits: { start: number; end: number; text: string }[] = [];
  const expected: string[] = [];
  for (const { install, replace } of changes) {
    if (install.line !== line) return null;
    const entries = [...replace];
    if (install.pinSubcommand && entries.some(([, t]) => t !== null)) entries.push([install.pinSubcommand[0], install.pinSubcommand[1]]);
    for (const [index, token] of entries) {
      const span = install.spans[index];
      if (!span) return null;
      if (token === null) {
        let start = span.start;
        while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start--;
        edits.push({ start, end: span.end, text: '' });
        continue;
      }
      const prefix = install.specs.find((s) => s.index === index)?.prefix ?? '';
      const text = quoteIn(span.quote, prefix + token);
      if (text === null) return null;
      edits.push({ start: span.start, end: span.end, text });
      if (index !== install.pinSubcommand?.[0]) {
        const spec = install.ecosystem === 'npm' ? npmSpec(token) : pySpec(token, true);
        if (spec) expected.push(spec);
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = line;
  let limit = Infinity;
  for (const e of edits) {
    if (e.end > limit) return null; // overlapping edits
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  const landed = new Set(parseInstalls(out).flatMap((i) => i.specs.filter((s) => s.confident).map((s) => s.spec)));
  return expected.every((s) => landed.has(s)) ? out : null;
}

/** Rewrite the command line around one install. */
export function rewrite(install: Install, replace: Map<number, string | null>): string | null {
  return rewriteCommand([{ install, replace }]);
}

/** The original token with its version pinned, preserving npm aliases and pip extras. */
export function pinToken(eco: Ecosystem, original: string, version: string): string {
  if (eco === 'npm') {
    const at = original.indexOf('@', original.startsWith('@') ? 1 : 0);
    const name = at === -1 ? original : original.slice(0, at);
    const rest = at === -1 ? '' : original.slice(at + 1);
    if (rest.startsWith('npm:')) return `${name}@npm:${pinToken('npm', rest.slice(4), version)}`;
    return `${name}@${version}`;
  }
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?/.exec(original);
  return `${m?.[1] ?? original}${m?.[2] ?? ''}==${version}`;
}
