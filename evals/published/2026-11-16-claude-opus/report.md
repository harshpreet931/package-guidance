# package-guidance uplift eval — eval-opus

- Run: `eval-opus` · agents run 2026-11-16 · scored 2026-11-17T05:46Z (registry data fetched 2026-11-16T12:47Z)
- 30 results · 15 prompts · agents: claude · arms: baseline, guided-hook · cooldown 7d · model opus
- Intervals: percentile 95% bootstrap CI (B=2000, prompt clusters). "n.s." = CI crosses 0.

## Headline

- **claude + guided-hook** vs baseline: dependency issues per run 4.27 → 2.20 (-48%, Δ 95% CI [-3.07, -1.20]); clean runs 13% → 40%; hallucinated packages 0.00 → 0.00 per run; counting only deps the agent added or changed: 1.67 → 0.00 (Δ 95% CI [-2.54, -0.93]).

### claude: guided-hook vs baseline — Final repo state (all direct deps)

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 4.27 (4.00) | 2.20 (2.00) | -2.07 | [-3.07, -1.20] | -48% | better |
| Runs with zero dependency issues <sub>% of runs</sub> | 13% (0%) | 40% (0%) | +27 pp | [+7 pp, +53 pp] |  | better |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.47 (0.00) | 0.27 (0.00) | -0.20 | [-0.40, 0.00] | -43% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 3.27 (3.00) | 2.07 (2.00) | -1.20 | [-2.00, -0.53] | -37% | better |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.80 (0.00) | 0.00 (0.00) | -0.80 | [-1.40, -0.27] | -100% | better |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.47 (0.00) | 0.27 (0.00) | -0.20 | [-0.53, 0.00] | -43% | n.s. |

<sub>Paired prompts: 15</sub>

### claude: guided-hook vs baseline — Secondary metrics

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Deps with a high/critical advisory <sub>deps/run</sub> | 0.20 (0.00) | 0.07 (0.00) | -0.13 | [-0.33, 0.00] | -67% | n.s. |
| Unique advisories <sub>advisories/run</sub> | 3.80 (0.00) | 2.93 (0.00) | -0.87 | [-2.53, 0.00] | -23% | n.s. |
| Share of direct deps with any issue <sub>% of deps</sub> | 57% (67%) | 36% (50%) | -21 pp | [-34 pp, -8 pp] |  | better |
| Deps listed in e18e module-replacements (secondary) <sub>deps/run</sub> | 0.80 (0.00) | 0.53 (0.00) | -0.27 | [-0.47, -0.07] | -33% | better |
| Packages created <30d before run (slopsquat risk, secondary) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Direct deps pinned exactly <sub>% of deps</sub> | 10% (0%) | 66% (67%) | +56 pp | [+36 pp, +76 pp] |  | better |
| Runs that left a lockfile <sub>% of runs</sub> | 93% (100%) | 87% (100%) | -7 pp | [-20 pp, 0 pp] |  | n.s. |
| Direct deps (count) <sub>deps/run</sub> | 7.80 (8.00) | 6.47 (6.00) | -1.33 | [-3.07, -0.33] | -17% |  |

<sub>Paired prompts: 15</sub>

### claude: guided-hook vs baseline — Only deps the agent added or changed

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 1.67 (1.00) | 0.00 (0.00) | -1.67 | [-2.54, -0.93] | -100% | better |
| Runs with zero dependency issues <sub>% of runs</sub> | 27% (0%) | 100% (100%) | +73 pp | [+53 pp, +93 pp] |  | better |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.20 (0.00) | 0.00 (0.00) | -0.20 | [-0.40, 0.00] | -100% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 0.80 (0.00) | 0.00 (0.00) | -0.80 | [-1.27, -0.33] | -100% | better |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.80 (0.00) | 0.00 (0.00) | -0.80 | [-1.40, -0.27] | -100% | better |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.20 (0.00) | 0.00 (0.00) | -0.20 | [-0.53, 0.00] | -100% | n.s. |

<sub>Paired prompts: 15</sub>

### claude: guided-hook vs baseline — Agent health & manipulation check

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Agent finished without error/timeout <sub>% of runs</sub> | 100% (100%) | 93% (100%) | -7 pp | [-20 pp, 0 pp] |  | n.s. |
| package-guidance used in transcript (manipulation check) <sub>% of runs</sub> | 0% (0%) | 100% (100%) | +100 pp | [+100 pp, +100 pp] |  |  |
| Agent cost <sub>USD/run</sub> | $0.33 ($0.33) | $0.40 ($0.41) | +$0.07 | [+$0.02, +$0.10] | +21% |  |
| Agent wall time <sub>min/run</sub> | 1.65 (1.56) | 4.55 (1.78) | +2.90 | [+0.06, +6.99] | +176% |  |

<sub>Paired prompts: 15</sub>

## Per group

| Group | n | Issues/run (mean, 95% CI) | Median | Clean runs | Hallucinated/run | Fresh/run | Vulnerable/run |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude/baseline | 15 | 4.27 [2.93, 5.73] | 4.00 | 13% | 0.00 | 0.80 | 0.47 |
| claude/guided-hook | 15 | 2.20 [1.13, 3.53] | 2.00 | 40% | 0.00 | 0.00 | 0.27 |

## Per prompt (mean dependency issues per run)

| Prompt | claude/baseline | claude/guided-hook |
|---|---:|---:|
| cli-parallel-download | 0 | 0 |
| cra-add-routing | 5 | 3 |
| cra-modernize-build | 6 | 0 |
| express-jwt | 3 | 3 |
| express-uploads-s3 | 4 | 3 |
| express-validation-ratelimit | 4 | 2 |
| fastapi-orm-settings | 2 | 0 |
| flask-jwt | 5 | 2 |
| nextjs-form-validation | 9 | 8 |
| node-cli-report | 3 | 3 |
| node-postgres-orm | 0 | 0 |
| react-dashboard | 1 | 0 |
| ts-lint-format | 7 | 3 |
| ts-tests-coverage | 9 | 6 |
| vue-app-store | 6 | 0 |

## What the agents picked (most frequent offenders)

**claude/baseline**

- Deprecated: `npm:eslint@8.57.1` ×2, `npm:recharts@2.15.4`, `npm:next@13.4.19`, `npm:request@2.88.2`, `npm:eslint@9.39.5`, `npm:axios-retry@4.5.0`
- Behind current major: `npm:body-parser@1.20.9` ×3, `npm:express@4.22.3` ×3, `npm:nodemon@2.0.22` ×3, `npm:react@18.3.1` ×2, `npm:react-dom@18.3.1` ×2, `npm:web-vitals@2.1.4` ×2, `npm:@types/react@18.3.31` ×2, `npm:eslint@8.57.1` ×2
- Fresh (<cooldown) version: `npm:vite@8.3.8` ×3, `npm:@aws-sdk/client-s3@3.1169.0`, `npm:express-rate-limit@8.7.4`, `pypi:fastapi@0.163.1`, `pypi:pydantic-settings@2.16.3`, `npm:prettier@3.10.1`, `npm:typescript-eslint@8.72.2`, `npm:axios@1.21.1`
- Known advisory: `pypi:requests@2.22.0`, `pypi:python-dotenv@0.15.0`, `pypi:idna@2.8`, `pypi:urllib3@1.25.11`, `npm:next@13.4.19`, `npm:zod@3.25.76`, `npm:request@2.88.2`

**claude/guided-hook**

- Deprecated: `npm:eslint@8.57.1` ×2, `npm:next@13.4.19`, `npm:request@2.88.2`
- Behind current major: `npm:express@4.22.3` ×3, `npm:nodemon@2.0.22` ×3, `npm:body-parser@1.20.9` ×2, `npm:eslint@8.57.1` ×2, `npm:typescript@4.9.5` ×2, `npm:react@18.3.1`, `npm:react-dom@18.3.1`, `npm:web-vitals@2.1.4`
- Known advisory: `pypi:requests@2.22.0`, `pypi:python-dotenv@0.15.0`, `npm:next@13.4.19`, `npm:request@2.88.2`

## Method (short)

Each prompt runs in a fresh temp copy of its fixture, once per arm (baseline = no skill; guided = `skills/package-guidance` copied into `.claude/skills/`). The final manifests and lockfiles are scored against public data only — npm registry / PyPI JSON (existence, `deprecated`/yanked, current major, publish times) and OSV.dev `querybatch` — never with package-guidance itself. "Behind the current major" compares against the latest stable release that was already ≥ cooldown days old at run time, so an agent is not penalised for honouring the cooldown. Fresh-version exposure counts direct deps resolved to a version published < cooldown days before the run started. Without a lockfile, OSV is queried at the range minimum and other checks use the highest version the range would have resolved to at run time. See `evals/README.md` for threats to validity.

