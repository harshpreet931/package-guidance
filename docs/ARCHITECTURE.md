# Architecture

package-guidance has one job: when an agent is about to add a dependency, answer *which package, which version, and is it safe?* using live registry data, and make that answer cheap to act on.

```
skills/package-guidance/SKILL.md   tells the agent the procedure and to run `check` first
hooks/pre-tool-use.mjs             Claude Code hook: catches installs the agent didn't check
        │
        ▼
bin/package-guidance.js → src/cli.ts       check · scan · guide · harden · hook
        │
        ▼
src/check.ts   the decision procedure (below)
   ├─ src/registry.ts   versions + publish times (deps.dev, npm, PyPI)
   ├─ src/osv.ts        advisories + malware (OSV.dev)
   ├─ src/knowledge.ts  curated entries (data/entries), e18e replacements (data/e18e.json), guides/
   └─ src/semver.ts     npm and PEP 440 version grammars
src/shell.ts   finds installs inside shell commands (for the hook)
src/project.ts package manager + configured cooldown detection
src/harden.ts  writes a cooldown into the repo's own package-manager config (data/cooldown.json)
```

No runtime dependencies. Responses are cached for an hour in `~/.cache/package-guidance`.

## The decision procedure (`src/check.ts`)

For each requested package, a pipeline of stages emits **findings**. The most severe finding becomes the verdict. At the same severity, curated knowledge supplies the headline because it says *why* and *what to do*. Everything else becomes notes.

1. **resolve:** does it exist? A 404 means `not-found` (likely hallucinated).
2. **select:**
   - `resolved`: what the request resolves to, i.e. the newest *settled* match (older than the cooldown).
   - `pick`: what we recommend. It moves to the current major when the request is on an old one.
   - `wouldInstall`: what the package manager would actually take today. The hook compares it with `pick`.
3. **security:** advisories on the requested version. `malicious` (OSV `MAL-`) is never installable.
   - If the settled version has a high/critical advisory, it moves to a fixed release: a settled fix if one exists, otherwise the **first** patched fresh release (a cooldown exception). It never takes the newest one, so a release published right after a real fix isn't picked just for being newest. The fresh fix is flagged for review.
   - If the repo enforces its own cooldown (`.npmrc`, `pnpm-workspace.yaml`, `bunfig.toml`, …), the package manager would refuse that fresh fix, so the result says exactly how to exempt that one version (or package, where the manager can't pin versions) until it settles.
   - If no fixed version exists, it blocks and says to choose an alternative.
4. **adoption:** brand-new or near-zero-download packages are `young` / `unproven` (slopsquat risk).
5. **install:** npm lifecycle scripts, PyPI yanks.
6. **knowledge:** curated entries first, then e18e module-replacements.

Verdicts: `ok` · `caution` · `outdated` · `replace` · `deprecated` · `vulnerable` · `malicious` · `not-found` · `young` · `unproven` · `error`.
Severities: `ok` · `info` · `warn` · `block`.

## The hook (`src/hook.ts`, `src/shell.ts`)

A wrong deny costs the user more than a missed block, so the hook is conservative by construction:

- `shell.ts` tokenizes like a shell: quotes, comments, redirects, heredocs and continuations. Every spec it finds is tagged `confident` or not. A spec right after an unknown flag might be that flag's value, so it is low-confidence.
- The hook **denies** only confident specs whose severity is `block`, plus unpinned or ranged installs that would pull a release younger than the cooldown when the repo configures no cooldown of its own.
- A 404 on a private registry (flags or `.npmrc`) is expected, not a hallucination.
- `npx`/`bunx`/`npm exec` are skipped when the binary is already installed locally.
- "Run instead" rewrites the original command in place (keeping `-D`, `-g`, extras and index URLs) and shell-quotes it.
- Registry-controlled text is sanitized and quoted as data.
- It never emits `allow`, has a time budget, and fails open.
- `hooks/pre-tool-use.mjs` is a zero-dependency pre-filter that costs about 25 ms on commands that install nothing.

## Self-pinning

The skill and the hook run an **exact** version of this tool (`package-guidance@X.Y.Z`), never `@latest`. `npm version` runs `scripts/sync-version.mjs` to update every pinned reference.

## Data

- `data/entries/<ecosystem>/<id>.json`: curated traps. See `data/README.md`. Each entry needs a primary source and `last_verified`.
- `guides/<id>.md`: migration guides written for agents.
- `data/cooldown.json`: per-package-manager release-age settings, sourced from official docs.
- `data/e18e.json`: vendored [module-replacements](https://github.com/es-tooling/module-replacements) (MIT), refreshed weekly.

`scripts/validate-data.mjs` checks schema and cross-references in CI. With `--live` it re-checks every entry against the registries, and a weekly workflow opens a PR with anything that drifted.

## Evals

`evals/` measures whether agents pick better dependencies with package-guidance than without it. The scorer uses only public registry and OSV data and never this tool's code. See [`evals/README.md`](../evals/README.md).
