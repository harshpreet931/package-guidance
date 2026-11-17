# package-guidance evals

A reproducible with-vs-without benchmark. We give a coding agent the same realistic prompt twice:
once as it ships (**baseline**), once with the `package-guidance` skill installed (**guided**). Then
we score the dependencies it left behind using public registry and advisory data only.
The headline deltas are the launch numbers. `chart-data.json` feeds the landing site.

Node ≥ 20, ESM, zero dependencies (`child_process`, `fs`, `fetch`).

```
evals/
  prompts.json        31 prompts (21 npm, 10 PyPI; 18 start from a fixture repo). The first 5 are the pilot mix.
  fixtures/<name>/    small legacy starting repos: cra-app, eslintrc-ts, express-api, nextjs-app,
                      node-cli-legacy, flask-legacy, fastapi-svc, py-legacy-lib
  run.mjs             runs prompt × arm × agent × seed in fresh temp repos
  score.mjs           scores a run against npm / PyPI / OSV (never against package-guidance itself)
  report.mjs          writes report.md + chart-data.json
  lib/                arg parsing, stats, version math, manifest/lockfile parsers, registry clients, agent adapters
  test/               unit tests for the scorer's parsers (node --test test/*.test.mjs)
  test-fixtures/      hand-made "results" for validating the scorer with no AI involved
  results/<runId>/    output (git-ignored)
```

## Quick start

```bash
cd evals
node run.mjs --dry-run                                   # full plan + cost estimate, runs nothing
npm run selftest                                         # score the hand-made fixtures against live APIs (no AI)
npm test                                                 # parser unit tests
npm run plumbing                                         # run.mjs end to end with a deterministic mock agent (no AI)

# pilot: 5 prompts × 2 arms × 1 seed with Claude Code (~10 sessions, ≈ $10, ≈ 30 min)
node run.mjs --agents claude --arms baseline,guided --prompts 5 --seeds 1 --concurrency 2 --run-id pilot-1
node score.mjs results/pilot-1 && node report.mjs results/pilot-1
open results/pilot-1/report.md
```

### run.mjs flags

| Flag | Default | Meaning |
|---|---|---|
| `--agents` | `claude` | `claude` (works), `codex`, `cursor` (stubs, need `--allow-stub`), `mock` (no-AI plumbing test) |
| `--arms` | `baseline,guided` | `baseline`, `guided` (skill copied to `.claude/skills/package-guidance`), `guided-hook` (guided plus a PreToolUse hook in `.claude/settings.json`) |
| `--prompts` | `all` | `N` (first N), `npm`, `pypi`, or `id1,id2` |
| `--seeds` | `1` | repetitions (count, or a list like `1,2,3`) |
| `--concurrency` | `2` | parallel agent sessions |
| `--timeout` | `20` | minutes per session (the process group is killed afterwards) |
| `--model` | CLI default | passed to the agent. **Always pin this for launch runs.** |
| `--max-budget-usd` | none | per-session cap (Claude, if the CLI supports it) |
| `--run-id` | timestamp | output dir. Reusing an id **resumes** and skips completed sessions (`--force` re-runs them). |
| `--hook-cmd` | `hooks/hooks.json`, else `node bin/package-guidance.js hook`, else `npx -y package-guidance@latest hook` | hook for `guided-hook` |
| `--keep-workspace` | off | also save the final source tree (without node_modules, .git or dist) so `score.mjs --build` can work |
| `--build-check` | off | after the agent finishes, run `npm install --ignore-scripts && npm run build --if-present` and/or `python3 -m compileall` in the temp repo, and save `build.json` |
| `--calibrate <runDir>` | — | dry-run cost and time from a previous run's measured `costUsd` and `durationMs` |
| `--dry-run` | — | prints the plan, the cost estimate, the exact agent command and any preflight warnings |

What each session does:
1. Copy the fixture (or an empty dir) into a fresh `mkdtemp`, then `git init` and commit.
2. Save `snapshot-before/`.
3. For guided arms, install the skill and the optional hook.
4. Run the agent headless with a timeout. For Claude that is `claude -p <prompt> --output-format json --allowedTools <allowlist> --permission-mode acceptEdits --setting-sources project,local --strict-mcp-config` (guarded mode, below).
5. Save the outputs:
   - `transcript.json` and `stderr.log`
   - `session.jsonl`, the full Claude tool-call log copied from `~/.claude/projects`
   - `snapshot/`, the manifests, lockfiles and package-manager config only
   - `changes.txt` (git status), `prompt.txt` and `meta.json`, which holds the timestamps, cost, exit status and the command
6. Delete the temp dir.

Sessions are ordered prompt by prompt, so both arms of a pair run minutes apart, and the arm order alternates by seed.

Both arms get the same prompt text: the task plus a fixed preamble that tells the agent to work non-interactively and to install what it picks, so a lockfile exists. The prompt never mentions the skill. The guided arm has to discover it from its description, which is how it works in real use.

## Subscription usage gate

Claude Code sessions run on your subscription. Before each launch, `lib/usage.mjs` makes a one-token Haiku probe and reads the `rate_limit_event` Claude Code emits, which carries utilization of the 5-hour and weekly windows. If either is at or above `PG_USAGE_MAX` (default `0.8`), the runner logs `⏸ pausing until …` and sleeps until that window resets. Sessions already in flight finish. Each result records `usageAtStart`.

## Multi-model choice eval (choice.mjs)

`choice.mjs` asks any OpenAI-compatible `/chat/completions` endpoint which install commands it would run for each prompt. Nothing is executed. The commands are turned into manifests and graded by the same scorer. It has three arms:

- `baseline`: the prompt only.
- `registry`: a generic `registry_lookup` tool (latest version, publish date, deprecation). This is the fairness control: does package-guidance beat plain registry access?
- `guided`: the skill as system prompt, plus `package_guidance_check` and `package_guidance_guide` tools backed by the local CLI.

```sh
node choice.mjs --models kimi-latest,glm-latest --base-url http://localhost:3456 --seeds 2 --run-id choice-1
node score.mjs results/choice-1 && node report.mjs results/choice-1
```

If the endpoint becomes unreachable (VPN, budget), workers wait and resume. Re-running with the same `--run-id` keeps finished conversations and retries failed ones.

A conversation that fails at the endpoint has no answer. The scorer leaves it out of every dependency metric; it counts only against "agent finished without error". The report lists any comparison with fewer than 10 paired prompts as incomplete. If the extractor changes, `node choice.mjs --reextract --run-id <id>` re-parses the saved answers without calling a model. Packages the answer defines itself, such as workspace members, are excluded.

## Published results

Scored reports are committed under [`published/`](published/). Raw transcripts are not, because they contain local machine details.

## Scoring (score.mjs)

```bash
node score.mjs <runDir> [--out <dir>] [--cooldown 7] [--build] [--registry-snapshot <file> [--offline]]
```

For each result dir, the scorer reads every `package.json`, `pyproject.toml` (PEP 621, dependency-groups, Poetry) and `requirements*.txt` in `snapshot/`. It resolves each **direct** dependency from the nearest lockfile: `package-lock.json`/`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` (v1 and berry), `bun.lock`, `uv.lock`, `poetry.lock` or `Pipfile.lock`. With no lockfile, it falls back to the manifest. `T` below is the session's `startedAt`.

| Metric | Definition | Source |
|---|---|---|
| `notFound` (hallucinated) | Registry returns 404, or the package is fully unpublished | `registry.npmjs.org/<name>`, `pypi.org/pypi/<name>/json` |
| `deprecated` | The resolved version, or the whole package (deprecated `latest`), has the npm `deprecated` field set. On PyPI: every file of the version is yanked, or the classifier is `Development Status :: 7 - Inactive` | same |
| `outdated` | Major of the installed version is less than the major of the latest stable release as of `T − cooldown`. Using `T − cooldown` means a major released two days before the run doesn't count against an agent that honours the cooldown. | `dist-tags.latest` + per-version `time` / PyPI `upload_time` |
| `fresh` (fresh-version exposure) | The installed version was published less than `cooldown` days (default 7) before `T` | per-version publish time |
| `vulnerable` / `highCrit` / `advisories` | At least one OSV advisory, after collapsing aliases (GHSA, PYSEC and CVE for the same issue count once). High/critical uses the GHSA `database_specific.severity`, borrowed from a GHSA alias for PYSEC records. `MAL-*` counts as critical. | `api.osv.dev/v1/querybatch`, then `/v1/vulns/{id}` |
| `issueDeps` | Direct deps with any of the five issues above (each dep counts once) | — |
| `clean` | `issueDeps == 0` for the run | — |
| `e18e`, `youngPkg`, `exactPinRate`, `hasLockfile` | Secondary only, never part of `issueDeps`. `e18e`: listed in e18e module-replacements. `youngPkg`: package created less than 30 days before `T`. `exactPinRate`: share of deps pinned exactly. `hasLockfile`: a lockfile exists. | jsDelivr `module-replacements@3` |
| `buildOk` | Optional. With `--build`, it reinstalls and builds the saved `workspace/` (needs `run.mjs --keep-workspace`); otherwise it uses `build.json` from `run.mjs --build-check` | local |
| `skillTriggered` | Manipulation check: a tool call in the session log mentions `package-guidance`. Should be ~0 for baseline and high for guided. | `session.jsonl` |

Which version "installed" means:
- **Lockfile version**, if one exists.
- **The exact pin**, if the dep is pinned.
- **Otherwise, the highest version the range would have resolved to at `T`.** That is what `npm install` would have picked at that moment.

OSV is queried at the lockfile or pinned version. Without either, it is queried at the **range minimum**, the lowest published version the range allows. Both choices are recorded per dep in `score.json` (`resolvedFrom`, `osvVersion`).

Two scopes are reported:
- **Final repo state (all direct deps)** is the headline. It includes legacy fixture deps, so a guided agent that also upgrades `react-scripts` gets credit for it.
- **Only deps the agent added or changed** (`touched`) compares against `snapshot-before/`. It isolates what the agent picked itself.

Outputs:
- `<result>/score.json`: every dep with its flags, resolved versions, advisories and deprecation messages.
- `summary.json`, per agent × arm:
  - n, mean and median for each metric
  - a **95% percentile bootstrap CI** for the mean and the median (B = 2000, fixed seed)
  - deltas (guided − baseline) with a **paired cluster bootstrap CI**. Prompts are resampled, which accounts for prompts differing much more than seeds do.
- `registry-snapshot.json`: a compact copy of every registry and OSV response used. Re-score later with `--registry-snapshot <file> --offline` and you get the same numbers.

### Why the scorer is independent

We never grade ourselves with our own tool:
- `score.mjs` does not import, shell out to or read anything from `src/`, `bin/`, `data/` or `guides/`.
- It has its own semver/PEP 440 code (`lib/versions.mjs`) and its own manifest and lockfile parsers (`lib/manifests.mjs`).
- It asks the public sources directly.

**Curated opinions count for nothing.** "moment → date-fns", "CRA is sunset", "axios is unnecessary": none of these affect the headline. Only facts the registries and OSV publish count: 404, the `deprecated` flag, publish times, majors and advisories. A guided agent therefore gets no credit for following our curated advice unless that advice also shows up in the public data. The e18e list is reported separately as a secondary metric, because package-guidance also uses it.

## Report (report.mjs)

`node report.mjs <scoredRunDir>` writes:
- `report.md`: headline sentences; tables (final state, secondary, touched only, agent health); per-group and per-prompt tables; the most frequent offenders per flag; a method note.
- `chart-data.json` (`package-guidance-evals/chart-data@1`): per agent and arm, each headline metric's baseline, guided, delta, relative change, `ci95` and a `significant` flag (the CI excludes 0).

## Validating the scorer without AI

`test-fixtures/selftest/` is a fake run with agent name `fixture` and the startedAt fixed at `2026-11-16T08:45Z`:

- **baseline = bad**
  - npm, no lockfile: `request@^2.88.2`, `moment@^2.29.1`, `tailwindcss@^3.4.1`, `lodash@4.17.20`, a non-existent `react-tailwind-datepicker-pro-x`, `vite@8.3.8` (published 5 days before the run) and `react@^19.3.1` as a clean control.
  - Python: `requests==2.19.1`, `flask==0.12.2`, `pycrypto==2.6.1`, a non-existent `fastapi-jwt-settings-helperz` and `fastapi==0.163.1` (1 day old).
- **guided = good**: current-major versions that had settled for at least 7 days.
  - npm: exact pins with a `package-lock.json`.
  - Python: `pyproject.toml` with a `uv.lock`.

Expected results (live data on 2026-11-16):
- bad npm: 6 of 7 deps flagged.
  - `request` deprecated and vulnerable
  - `moment` vulnerable at its range minimum 2.29.1
  - `lodash` vulnerable
  - `tailwindcss` outdated (3 < 4)
  - the fake package not found
  - `vite` fresh
  - `react` clean
- bad Python: 5 of 5 flagged. `flask` is outdated and vulnerable.
- good npm and good Python: 0 issues.

`pycrypto` shows up as vulnerable but not deprecated: PyPI has no deprecation flag for it. This is the independence rule working as intended.

## Cost estimate

From `--dry-run`, using API-equivalent prices. On a Claude subscription this is usage quota, not dollars. The assumption is about $0.90 per baseline session and +15% for guided, which also reads SKILL.md and runs checks. After the pilot, use `--calibrate results/pilot-1` to replace these assumptions with measured cost.

| Run | Sessions | Est. cost | Wall time |
|---|---:|---:|---:|
| Pilot: 5 prompts × 2 arms × 1 seed | 10 | ≈ $10 ($4–27) | ≈ 0.5 h @2 |
| Full, 1 seed | 62 | ≈ $60 ($23–167) | ≈ 3.3 h @2 |
| Launch: 31 × 2 arms × 3 seeds | 186 | ≈ $180 ($70–500) | ≈ 10 h @2 |
| Launch with hook arm: 31 × 3 arms × 3 seeds | 279 | ≈ $276 ($107–767) | ≈ 7.7 h @4 |

Scoring is free: public APIs, about 1–3 minutes.

## Threats to validity

- **Seeds are repetitions, not RNG seeds.** Headless agent CLIs don't expose a sampling seed, so `seed-N` just means the N-th independent session. Use at least 3 for launch numbers. CIs resample prompts, not sessions, so they stay honest even when seeds of one prompt are correlated.
- **Model and CLI drift.** Results apply to one model and CLI version. `run.json` records `--model`, the agent CLI version and the skill's content hash; `meta.json` records the models the CLI reports using. Don't compare runs with different values. Re-run before each launch claim instead of reusing old numbers.
- **The run date is part of the result.** "Outdated", "fresh" and "vulnerable" depend on the day. New majors and new advisories appear constantly.
  - Outdated and fresh are computed against publish times as of the session's `startedAt`, so re-scoring later doesn't move them.
  - OSV and the deprecation flags are fetched live at scoring time. An advisory published after the run makes the run look worse in hindsight. Score promptly, keep `registry-snapshot.json`, and state "scored on <date>" next to every number.
- **Arm order and time-of-day effects.** Pairs run close together and alternate order. Rate limits or provider incidents can still hit one arm, so check `agentOk` in the agent-health table.
- **Contamination of the baseline.** If the operator has package-guidance installed globally, the baseline would see it. Claude runs with `--setting-sources project,local --strict-mcp-config` to ignore user settings, plugins and MCP servers. Check that `skillTriggered` is about 0 for the baseline. User-level `CLAUDE.md` memory may still load; run under a clean account or `CLAUDE_CONFIG_DIR` for launch runs.
- **The preamble asks the agent to install**, so a lockfile exists. Without it, many agents only edit manifests. The scorer handles both cases (range min/max), but lockfile runs are more precise.
- **The prompt set is ours.** We wrote it, with traps where stale picks are likely. That favours the guided arm on purpose, because that is the claim being tested. Don't extrapolate the numbers to "all coding". Per-prompt tables are published so readers can see where the gains come from. Prompts that start from fixtures carry legacy deps in the final-state scope for both arms; the `touched` scope removes them.
- **Metric limits.**
  - "Outdated" uses semver major only, so `0.x` minors are not counted, which matters for FastAPI and uvicorn. CalVer packages count a year as a major.
  - Transitive deps are not scored.
  - Range resolution without a lockfile approximates npm/pip.
  - OSV can have false positives (advisories that don't apply in practice) and false negatives.
  - A dep can be flagged by several checks but counts once in `issueDeps`.
- **Safety.** By default runs are *guarded*:
  - The agent gets an allowlist: file tools, web lookups, package managers and read-only shell commands. Everything else is denied.
  - Package managers only resolve and write manifests and lockfiles: npm `package-lock-only` + `ignore-scripts`, pnpm `lockfile-only`, `UV_NO_SYNC`, `PIP_DRY_RUN`. No package code is downloaded into `node_modules` or executed.
  - `npx`/`npm create` scaffolders still run, as they would for a user.
  - Agents may waste a few turns trying to build without `node_modules`. Both arms are treated identically.
  - `PG_EVAL_UNGUARDED=1` restores `--dangerously-skip-permissions`. Only use it in a disposable VM or container.
  - `--build` and `--build-check` execute code the agent wrote.

## Adding prompts or fixtures

Append to `prompts.json` with these fields:
- `id`
- `ecosystem`: `npm` or `pypi`
- `fixture`: a dir under `fixtures/`, or `null` to start from an empty dir
- `kind`
- `prompt`
- `traps`: for humans only

Fixtures should be tiny, have a `.gitignore`, and pin the legacy versions you want the agent to encounter. Don't change prompts in the middle of a series: a prompt edit starts a new series.
