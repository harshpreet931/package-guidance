# package-guidance uplift eval — choice-multi-1

- Run: `choice-multi-1` · agents run 2026-11-16 · scored 2026-11-17T05:46Z (registry data fetched 2026-11-16T19:08Z)
- 186 results · 31 prompts · agents: kimi-latest · arms: baseline, guided, registry · cooldown 7d
- Intervals: percentile 95% bootstrap CI (B=2000, prompt clusters). "n.s." = CI crosses 0.


> **Setup.** A *choice* eval, not an agent eval: the model gets each task and replies with the install commands it would run, with no shell. Arms: **baseline** (no tools), **registry** (a `registry_lookup` tool returning live versions and publish dates: the fairness control) and **guided** (the package-guidance skill as the system prompt, plus `check` and `guide` tools). Model `kimi-latest` through an OpenAI-compatible gateway, 31 tasks × 2 seeds per arm. 4 of 62 guided conversations failed at the gateway (HTTP 502) and are excluded, not counted as clean. Both runs of one task (`py-config-yaml`) were among them, which is why the guided comparison has 30 paired prompts rather than 31. A GLM run was started too, but most of its conversations failed at the gateway, so it is not reported.

## Headline

- **kimi-latest + guided** vs baseline: dependency issues per run 1.11 → 0.07 (-94%, Δ 95% CI [-1.50, -0.68]); clean runs 42% → 97%; hallucinated packages 0.00 → 0.00 per run; counting only deps the agent added or changed: 1.11 → 0.07 (Δ 95% CI [-1.50, -0.68]).
- **kimi-latest + registry** vs baseline: dependency issues per run 1.11 → 1.05 (-6%, Δ 95% CI [-0.26, +0.10]); clean runs 42% → 40%; hallucinated packages 0.00 → 0.00 per run; counting only deps the agent added or changed: 1.11 → 1.05 (Δ 95% CI [-0.26, +0.10]).

### kimi-latest: guided vs baseline — Final repo state (all direct deps)

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 1.11 (1.00) | 0.07 (0.00) | -1.04 | [-1.50, -0.68] | -94% | better |
| Runs with zero dependency issues <sub>% of runs</sub> | 42% (0%) | 97% (100%) | +55 pp | [+40 pp, +73 pp] |  | better |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.05 (0.00) | 0.00 (0.00) | -0.05 | [-0.13, 0.00] | -100% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 0.29 (0.00) | 0.07 (0.00) | -0.22 | [-0.43, -0.07] | -76% | better |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.79 (0.00) | 0.00 (0.00) | -0.79 | [-1.22, -0.47] | -100% | better |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.08 (0.00) | 0.00 (0.00) | -0.08 | [-0.18, 0.00] | -100% | n.s. |

<sub>Paired prompts: 30</sub>

### kimi-latest: guided vs baseline — Secondary metrics

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Deps with a high/critical advisory <sub>deps/run</sub> | 0.05 (0.00) | 0.00 (0.00) | -0.05 | [-0.13, 0.00] | -100% | n.s. |
| Unique advisories <sub>advisories/run</sub> | 0.21 (0.00) | 0.00 (0.00) | -0.21 | [-0.53, 0.00] | -100% | n.s. |
| Share of direct deps with any issue <sub>% of deps</sub> | 35% (25%) | 1% (0%) | -34 pp | [-47 pp, -23 pp] |  | better |
| Deps listed in e18e module-replacements (secondary) <sub>deps/run</sub> | 0.15 (0.00) | 0.05 (0.00) | -0.09 | [-0.26, +0.03] | -64% | n.s. |
| Packages created <30d before run (slopsquat risk, secondary) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Direct deps pinned exactly <sub>% of deps</sub> | 7% (0%) | 100% (100%) | +93 pp | [+83 pp, +100 pp] |  | better |
| Runs that left a lockfile <sub>% of runs</sub> | 0% (0%) | 0% (0%) | 0 pp | [0 pp, 0 pp] |  | n.s. |
| Direct deps (count) <sub>deps/run</sub> | 3.52 (3.00) | 4.07 (3.00) | +0.55 | [-0.38, +1.52] | +16% |  |

<sub>Paired prompts: 30</sub>

### kimi-latest: guided vs baseline — Only deps the agent added or changed

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 1.11 (1.00) | 0.07 (0.00) | -1.04 | [-1.50, -0.68] | -94% | better |
| Runs with zero dependency issues <sub>% of runs</sub> | 42% (0%) | 97% (100%) | +55 pp | [+40 pp, +73 pp] |  | better |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.05 (0.00) | 0.00 (0.00) | -0.05 | [-0.13, 0.00] | -100% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 0.29 (0.00) | 0.07 (0.00) | -0.22 | [-0.43, -0.07] | -76% | better |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.79 (0.00) | 0.00 (0.00) | -0.79 | [-1.22, -0.47] | -100% | better |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.08 (0.00) | 0.00 (0.00) | -0.08 | [-0.18, 0.00] | -100% | n.s. |

<sub>Paired prompts: 30</sub>

### kimi-latest: guided vs baseline — Agent health & manipulation check

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Agent finished without error/timeout <sub>% of runs</sub> | 100% (100%) | 94% (100%) | -6 pp | [-15 pp, 0 pp] |  | n.s. |
| package-guidance used in transcript (manipulation check) <sub>% of runs</sub> | 0% (0%) | 0% (0%) | 0 pp | [0 pp, 0 pp] |  |  |
| Agent wall time <sub>min/run</sub> | 1.79 (1.26) | 2.30 (1.14) | +0.50 | [-0.59, +1.76] | +28% |  |

<sub>Paired prompts: 31</sub>

### kimi-latest: registry vs baseline — Final repo state (all direct deps)

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 1.11 (1.00) | 1.05 (1.00) | -0.06 | [-0.26, +0.10] | -6% | n.s. |
| Runs with zero dependency issues <sub>% of runs</sub> | 42% (0%) | 40% (0%) | -2 pp | [-8 pp, +5 pp] |  | n.s. |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.05 (0.00) | 0.00 (0.00) | -0.05 | [-0.13, 0.00] | -100% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 0.29 (0.00) | 0.27 (0.00) | -0.02 | [-0.18, +0.13] | -6% | n.s. |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.79 (0.00) | 0.77 (1.00) | -0.02 | [-0.16, +0.13] | -2% | n.s. |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.08 (0.00) | 0.02 (0.00) | -0.06 | [-0.15, 0.00] | -80% | n.s. |

<sub>Paired prompts: 31</sub>

### kimi-latest: registry vs baseline — Secondary metrics

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Deps with a high/critical advisory <sub>deps/run</sub> | 0.05 (0.00) | 0.02 (0.00) | -0.03 | [-0.08, 0.00] | -67% | n.s. |
| Unique advisories <sub>advisories/run</sub> | 0.21 (0.00) | 0.53 (0.00) | +0.32 | [-0.19, +1.19] | +154% | n.s. |
| Share of direct deps with any issue <sub>% of deps</sub> | 35% (25%) | 31% (25%) | -3 pp | [-10 pp, +1 pp] |  | n.s. |
| Deps listed in e18e module-replacements (secondary) <sub>deps/run</sub> | 0.15 (0.00) | 0.18 (0.00) | +0.03 | [-0.08, +0.15] | +22% | n.s. |
| Packages created <30d before run (slopsquat risk, secondary) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Direct deps pinned exactly <sub>% of deps</sub> | 7% (0%) | 86% (100%) | +80 pp | [+69 pp, +94 pp] |  | better |
| Runs that left a lockfile <sub>% of runs</sub> | 0% (0%) | 0% (0%) | 0 pp | [0 pp, 0 pp] |  | n.s. |
| Direct deps (count) <sub>deps/run</sub> | 3.52 (3.00) | 3.55 (3.00) | +0.03 | [-0.24, +0.29] | +1% |  |

<sub>Paired prompts: 31</sub>

### kimi-latest: registry vs baseline — Only deps the agent added or changed

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Direct deps with any issue <sub>deps/run</sub> | 1.11 (1.00) | 1.05 (1.00) | -0.06 | [-0.26, +0.10] | -6% | n.s. |
| Runs with zero dependency issues <sub>% of runs</sub> | 42% (0%) | 40% (0%) | -2 pp | [-8 pp, +5 pp] |  | n.s. |
| Hallucinated packages (registry 404) <sub>deps/run</sub> | 0.00 (0.00) | 0.00 (0.00) | 0.00 | [0.00, 0.00] |  | n.s. |
| Deprecated deps (registry flag / yanked / inactive) <sub>deps/run</sub> | 0.05 (0.00) | 0.00 (0.00) | -0.05 | [-0.13, 0.00] | -100% | n.s. |
| Deps behind the current major <sub>deps/run</sub> | 0.29 (0.00) | 0.27 (0.00) | -0.02 | [-0.18, +0.13] | -6% | n.s. |
| Fresh-version exposure (<7d old at run time) <sub>deps/run</sub> | 0.79 (0.00) | 0.77 (1.00) | -0.02 | [-0.16, +0.13] | -2% | n.s. |
| Deps with a known advisory (OSV) <sub>deps/run</sub> | 0.08 (0.00) | 0.02 (0.00) | -0.06 | [-0.15, 0.00] | -80% | n.s. |

<sub>Paired prompts: 31</sub>

### kimi-latest: registry vs baseline — Agent health & manipulation check

| Metric | Baseline mean (median) | Guided mean (median) | Δ mean | 95% CI | Rel. | |
|---|---:|---:|---:|---:|---:|---|
| Agent finished without error/timeout <sub>% of runs</sub> | 100% (100%) | 100% (100%) | 0 pp | [0 pp, 0 pp] |  | n.s. |
| package-guidance used in transcript (manipulation check) <sub>% of runs</sub> | 0% (0%) | 0% (0%) | 0 pp | [0 pp, 0 pp] |  |  |
| Agent wall time <sub>min/run</sub> | 1.79 (1.26) | 1.84 (1.13) | +0.05 | [-0.58, +0.56] | +3% |  |

<sub>Paired prompts: 31</sub>

## Per group

| Group | n | Issues/run (mean, 95% CI) | Median | Clean runs | Hallucinated/run | Fresh/run | Vulnerable/run |
|---|---:|---:|---:|---:|---:|---:|---:|
| kimi-latest/baseline | 62 | 1.11 [0.74, 1.55] | 1.00 | 42% | 0.00 | 0.79 | 0.08 |
| kimi-latest/guided | 62 | 0.07 [0.00, 0.21] | 0.00 | 97% | 0.00 | 0.00 | 0.00 |
| kimi-latest/registry | 62 | 1.05 [0.71, 1.42] | 1.00 | 40% | 0.00 | 0.77 | 0.02 |

## Per prompt (mean dependency issues per run)

| Prompt | kimi-latest/baseline | kimi-latest/guided | kimi-latest/registry |
|---|---:|---:|---:|
| cli-parallel-download | 0 | 0 | 0 |
| cra-add-routing | 1 | 0 | 0 |
| cra-markdown-editor | 2 | 0 | 2 |
| cra-modernize-build | 3 | 2 | 3 |
| csv-to-pdf | 0 | 0 | 0 |
| docs-site-md | 0 | 0 | 0 |
| express-email | 1.5 | 0 | 1 |
| express-jwt | 0 | 0 | 0 |
| express-uploads-s3 | 1 | 0 | 1 |
| express-validation-ratelimit | 1 | 0 | 1.5 |
| fastapi-add-db | 2 | 0 | 1.5 |
| fastapi-orm-settings | 2.5 | 0 | 2.5 |
| flask-background-jobs | 0 | 0 | 0 |
| flask-jwt | 0 | 0 | 0 |
| nextjs-auth | 3 | 0 | 3 |
| nextjs-form-validation | 2.5 | 0 | 2 |
| nextjs-i18n | 1 | 0 | 1 |
| node-cli-report | 0 | 0 | 0.5 |
| node-postgres-orm | 1 | 0 | 1 |
| py-async-http | 0 | 0 | 0 |
| py-cli-scraper | 0 | 0 | 0.5 |
| py-config-yaml | 0 | — | 0.5 |
| py-data-pipeline | 0 | 0 | 0 |
| py-encrypt-files | 0 | 0 | 0 |
| py-modernize-tooling | 1.5 | 0 | 1.5 |
| react-dashboard | 0.5 | 0 | 0.5 |
| ts-lint-format | 4 | 0 | 3.5 |
| ts-monorepo | 1 | 0 | 1 |
| ts-tests-coverage | 1 | 0 | 2 |
| vue-app-store | 3 | 0 | 1 |
| ws-chat-server | 2 | 0 | 2 |

## What the agents picked (most frequent offenders)

**kimi-latest/baseline**

- Deprecated: `npm:axios-retry@4.5.0` ×2, `npm:recharts@2.15.4`
- Behind current major: `npm:@types/react@18.3.31` ×2, `npm:@types/react-dom@18.3.7` ×2, `npm:@prisma/client@5.22.0` ×2, `npm:prisma@5.22.0` ×2, `npm:next-intl@3.26.5` ×2, `npm:@types/jest@27.5.2` ×2, `npm:vue-router@4.6.5` ×2, `npm:react-router-dom@6.30.6`
- Fresh (<cooldown) version: `pypi:pydantic-settings@2.16.3` ×4, `npm:marked@18.2.0` ×2, `npm:dompurify@3.4.18` ×2, `npm:vite@8.3.8` ×2, `npm:nodemailer@10.6.0` ×2, `npm:@aws-sdk/client-s3@3.1169.0` ×2, `npm:express-rate-limit@8.7.4` ×2, `pypi:uv@0.13.8` ×2
- Known advisory: `npm:next-auth@4.24.11` ×2, `npm:next-intl@3.26.5` ×2, `npm:zod@3.25.76`

**kimi-latest/guided**

- Behind current major: `npm:@types/react@18.3.31` ×2, `npm:@types/react-dom@18.3.7` ×2

**kimi-latest/registry**

- Behind current major: `npm:@types/react@18.3.31` ×2, `npm:@types/react-dom@18.3.7` ×2, `npm:@prisma/client@6.19.3` ×2, `npm:prisma@6.19.3` ×2, `npm:jest@29.7.0` ×2, `npm:@types/jest@29.5.14` ×2, `npm:express@4.22.3`, `npm:next@13.5.11`
- Fresh (<cooldown) version: `pypi:pydantic-settings@2.16.3` ×5, `npm:marked@18.2.0` ×2, `npm:dompurify@3.4.18` ×2, `npm:vite@8.3.8` ×2, `npm:nodemailer@10.6.0` ×2, `npm:@aws-sdk/client-s3@3.1169.0` ×2, `npm:express-rate-limit@8.7.4` ×2, `pypi:uv@0.13.8` ×2
- Known advisory: `npm:next@13.5.11`

## Method (short)

Each prompt runs in a fresh temp copy of its fixture, once per arm (baseline = no skill; guided = `skills/package-guidance` copied into `.claude/skills/`). The final manifests and lockfiles are scored against public data only — npm registry / PyPI JSON (existence, `deprecated`/yanked, current major, publish times) and OSV.dev `querybatch` — never with package-guidance itself. "Behind the current major" compares against the latest stable release that was already ≥ cooldown days old at run time, so an agent is not penalised for honouring the cooldown. Fresh-version exposure counts direct deps resolved to a version published < cooldown days before the run started. Without a lockfile, OSV is queried at the range minimum and other checks use the highest version the range would have resolved to at run time. See `evals/README.md` for threats to validity.

