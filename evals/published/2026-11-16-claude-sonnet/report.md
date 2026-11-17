# package-guidance uplift eval — eval-sonnet

- Run: `eval-sonnet` · agents run 2026-11-16 · scored 2026-11-17T05:46Z (registry data fetched 2026-11-16T12:09Z)
- 124 results · 31 prompts · agents: claude · arms: baseline, guided-hook · cooldown 7d · model sonnet
- Intervals: percentile 95% bootstrap CI (B=2000, prompt clusters). "n.s." = CI crosses 0.

## Headline

- **claude + guided-hook** vs baseline: dependency issues per run 3.16 → 2.11 (-33%, Δ 95% CI [-1.65, -0.53]); clean runs 27% → 45%; hallucinated packages 0.00 → 0.00 per run; counting only deps the agent added or changed: 1.08 → 0.15 (Δ 95% CI [-1.50, -0.47]).

### claude: guided-hook vs baseline — Final repo state (all direct deps)

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 3.16 (3.00) | 2.11 (1.00) | -1.05 | [-1.65, -0.53] | -33% | better |
| Runs with zero dependency issues <sub>% of runs</sub> | 27% (0%) | 45% (0%) | +18 pp | [+5 pp, +32 pp] |  | better |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.34 (0.00) | 0.26 (0.00) | -0.08 | [-0.18, 0.00] | -24% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 2.35 (2.00) | 1.98 (1.00) | -0.37 | [-0.69, -0.11] | -16% | better |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.66 (0.00) | 0.03 (0.00) | -0.63 | [-0.98, -0.32] | -95% | better |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.47 (0.00) | 0.35 (0.00) | -0.11 | [-0.24, -0.02] | -24% | better |

<sub>Paired prompts: 31</sub>

### claude: guided-hook vs baseline — Secondary metrics

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Deps with a high/critical advisory <sub>deps/run</sub> | 0.19 (0.00) | 0.16 (0.00) | -0.03 | [-0.08, 0.00] | -17% | n.s. |
| Unique advisories <sub>advisories/run</sub> | 4.61 (0.00) | 4.19 (0.00) | -0.42 | [-0.87, -0.06] | -9% | better |
| Share of direct deps with any issue <sub>% of deps</sub> | 52% (65%) | 33% (20%) | -19 pp | [-30 pp, -10 pp] |  | better |
| Deps listed in e18e module-replacements (secondary) <sub>deps/run</sub> | 0.48 (0.00) | 0.35 (0.00) | -0.13 | [-0.29, 0.00] | -27% | n.s. |
| Packages created <30d before run (slopsquat risk, secondary) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Direct deps pinned exactly <sub>% of deps</sub> | 13% (0%) | 77% (100%) | +64 pp | [+50 pp, +77 pp] |  | better |
| Runs that left a lockfile <sub>% of runs</sub> | 90% (100%) | 90% (100%) | 0 pp | [0 pp, 0 pp] |  | n.s. |
| Direct deps (count) <sub>deps/run</sub> | 5.50 (5.00) | 5.26 (5.00) | -0.24 | [-0.45, -0.08] | -4% |  |

<sub>Paired prompts: 31</sub>

### claude: guided-hook vs baseline — Only deps the agent added or changed

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 1.08 (1.00) | 0.15 (0.00) | -0.94 | [-1.50, -0.47] | -87% | better |
| Runs with zero dependency issues <sub>% of runs</sub> | 47% (0%) | 92% (100%) | +45 pp | [+29 pp, +61 pp] |  | better |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.08 (0.00) | 0.00 (0.00) | -0.08 | [-0.18, 0.00] | -100% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 0.42 (0.00) | 0.15 (0.00) | -0.27 | [-0.55, -0.05] | -65% | better |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.63 (0.00) | 0.00 (0.00) | -0.63 | [-0.98, -0.32] | -100% | better |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.11 (0.00) | 0.00 (0.00) | -0.11 | [-0.21, -0.03] | -100% | better |

<sub>Paired prompts: 31</sub>

### claude: guided-hook vs baseline — Agent health & manipulation check

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Agent finished without error/timeout <sub>% of runs</sub> | 98% (100%) | 98% (100%) | 0 pp | [0 pp, 0 pp] |  | n.s. |
| package-guidance used in transcript (manipulation check) <sub>% of runs</sub> | 0% (0%) | 100% (100%) | +100 pp | [+100 pp, +100 pp] |  |  |
| Agent cost <sub>USD/run</sub> | $0.15 ($0.15) | $0.18 ($0.18) | +$0.03 | [+$0.01, +$0.04] | +17% |  |
| Agent wall time <sub>min/run</sub> | 2.72 (0.88) | 2.01 (0.99) | -0.71 | [-2.34, +0.34] | -26% |  |

<sub>Paired prompts: 31</sub>

## Per group

| Group | n | Issues/run (mean, 95% CI) | Median | Clean runs | Hallucinated/run | Fresh/run | Vulnerable/run |
|---|---:|---:|---:|---:|---:|---:|---:|
| claude/baseline | 62 | 3.16 [2.18, 4.16] | 3.00 | 27% | 0.00 | 0.66 | 0.47 |
| claude/guided-hook | 62 | 2.11 [1.19, 3.05] | 1.00 | 45% | 0.00 | 0.03 | 0.35 |

## Per prompt (mean dependency issues per run)

| Prompt | claude/baseline | claude/guided-hook |
|---|---:|---:|
| cli-parallel-download | 0 | 0 |
| cra-add-routing | 4 | 3 |
| cra-markdown-editor | 5 | 3 |
| cra-modernize-build | 5.5 | 4 |
| csv-to-pdf | 0 | 0 |
| docs-site-md | 1 | 0 |
| express-email | 4 | 3 |
| express-jwt | 3 | 3 |
| express-uploads-s3 | 4 | 3 |
| express-validation-ratelimit | 4.5 | 3 |
| fastapi-add-db | 2 | 1 |
| fastapi-orm-settings | 2 | 0 |
| flask-background-jobs | 3 | 2.5 |
| flask-jwt | 2 | 2.5 |
| nextjs-auth | 8 | 8 |
| nextjs-form-validation | 8 | 8 |
| nextjs-i18n | 9 | 8 |
| node-cli-report | 3 | 3 |
| node-postgres-orm | 0 | 0 |
| py-async-http | 3 | 2 |
| py-cli-scraper | 0 | 0 |
| py-config-yaml | 0 | 0 |
| py-data-pipeline | 0 | 0 |
| py-encrypt-files | 0 | 0 |
| py-modernize-tooling | 2 | 0 |
| react-dashboard | 1 | 0 |
| ts-lint-format | 7 | 1 |
| ts-monorepo | 0 | 0 |
| ts-tests-coverage | 9 | 7.5 |
| vue-app-store | 6.5 | 0 |
| ws-chat-server | 1.5 | 0 |

## What the agents picked (most frequent offenders)

**claude/baseline**

- Deprecated: `npm:eslint@8.57.1` ×8, `npm:next@13.4.19` ×6, `npm:request@2.88.2` ×2, `npm:eslint@9.39.5` ×2, `npm:axios-retry@4.5.0` ×2, `npm:recharts@2.15.4`
- Behind current major: `npm:@types/react@18.3.31` ×8, `npm:body-parser@1.20.9` ×8, `npm:express@4.22.3` ×8, `npm:nodemon@2.0.22` ×8, `npm:eslint@8.57.1` ×8, `npm:typescript@5.9.3` ×8, `npm:react@18.3.1` ×6, `npm:react-dom@18.3.1` ×6
- Fresh (<cooldown) version: `npm:vite@8.3.8` ×5, `npm:marked@18.2.0` ×4, `pypi:fastapi@0.163.1` ×4, `pypi:pydantic-settings@2.16.3` ×4, `npm:dompurify@3.4.18` ×2, `npm:nodemailer@10.6.0` ×2, `npm:@aws-sdk/client-s3@3.1169.0` ×2, `npm:express-rate-limit@8.7.4` ×2
- Known advisory: `npm:next@13.4.19` ×6, `pypi:requests@2.22.0` ×5, `pypi:python-dotenv@0.15.0` ×5, `pypi:flask@1.1.2` ×4, `npm:next-intl@3.26.5` ×2, `npm:request@2.88.2` ×2, `pypi:pytest@8.4.2` ×2, `npm:zod@3.25.76`

**claude/guided-hook**

- Deprecated: `npm:eslint@8.57.1` ×8, `npm:next@13.4.19` ×6, `npm:request@2.88.2` ×2
- Behind current major: `npm:@types/react@18.3.31` ×8, `npm:body-parser@1.20.9` ×8, `npm:express@4.22.3` ×8, `npm:nodemon@2.0.22` ×8, `npm:eslint@8.57.1` ×8, `npm:react@18.3.1` ×6, `npm:react-dom@18.3.1` ×6, `pypi:python-dotenv@0.15.0` ×6
- Fresh (<cooldown) version: `pypi:fastapi@0.163.1` ×2
- Known advisory: `pypi:python-dotenv@0.15.0` ×6, `npm:next@13.4.19` ×6, `pypi:flask@1.1.2` ×4, `pypi:requests@2.22.0` ×4, `npm:request@2.88.2` ×2

## Method (short)

Each prompt runs in a fresh temp copy of its fixture, once per arm (baseline = no skill; guided = `skills/package-guidance` copied into `.claude/skills/`). The final manifests and lockfiles are scored against public data only — npm registry / PyPI JSON (existence, `deprecated`/yanked, current major, publish times) and OSV.dev `querybatch` — never with package-guidance itself. "Behind the current major" compares against the latest stable release that was already ≥ cooldown days old at run time, so an agent is not penalised for honouring the cooldown. Fresh-version exposure counts direct deps resolved to a version published < cooldown days before the run started. Without a lockfile, OSV is queried at the range minimum and other checks use the highest version the range would have resolved to at run time. See `evals/README.md` for threats to validity.

