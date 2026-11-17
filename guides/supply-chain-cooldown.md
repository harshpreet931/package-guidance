# Supply-chain cooldown: never install "latest" blind
Applies to: every npm / pnpm / yarn / bun / uv / pip / poetry install   ·   Last verified: 2026-11-16   ·   Source: https://pnpm.io/settings/dependency-resolution#minimumreleaseage

Malicious versions are usually caught and pulled within **minutes to hours**. An install that resolves to a version published an hour ago gets exactly that window. A cooldown, meaning "only versions at least N days old", turns most of these worms into non-events. Default here: **7 days**.

## Why "latest" is dangerous: real incidents
| Date (UTC unless noted) | Incident | What a cooldown would have done |
|---|---|---|
| 2025-08-26 | **nx "s1ngularity"**: a stolen npm token was used to publish malicious `nx` 20.x/21.x and `@nx/*` versions. A postinstall script stole credentials and drove local AI CLIs with a "file-search agent" prompt to inventory secrets. The bad versions were tagged `latest` for about 4 h (6:37–10:44 PM EDT). The Nx Console extension auto-installed `nx@latest`. ([GHSA-cxm3-wv7p-598c](https://github.com/advisories/GHSA-cxm3-wv7p-598c)) | Blocked: the versions were gone long before day 1. |
| 2025-09-08 | **chalk / debug compromise**: a maintainer was phished, and `chalk@5.6.1`, `debug@4.4.2` and over a dozen other core packages shipped a crypto-wallet interceptor. ([GHSA-2v46-p5h4-248w](https://github.com/advisories/GHSA-2v46-p5h4-248w), [GHSA-4x49-vf9v-38px](https://github.com/advisories/GHSA-4x49-vf9v-38px)) | Blocked: removed within hours. |
| 2025-09-14 | **Shai-Hulud**: the first self-replicating npm worm. It stole tokens, then republished the victims' own packages with a postinstall payload. GitHub removed 500+ packages. ([GitHub blog](https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/)) | Blocked, and it stops the worm from spreading through you. |
| 2025-11-24 | **Shai-Hulud 2.0 "The Second Coming"**: about 800 packages. It moved to **preinstall** (runs even if the install later fails) with `setup_bun.js`, and exfiltrated secrets to public GitHub repos. ([Datadog](https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/)) | Blocked. ignore-scripts also blocks it. |
| 2026-04-22 | **@bitwarden/cli 2026.4.0** was malicious on npm for about 93 min (5:57–7:30 PM ET). CVE-2026-42994. ([Bitwarden](https://community.bitwarden.com/t/bitwarden-statement-on-checkmarx-supply-chain-incident/96127)) | Blocked. |
| 2026-05-11 | **TanStack "Mini Shai-Hulud"**: 84 malicious versions of 42 `@tanstack/*` router/start packages in 6 minutes (19:20–19:26). They were published through the project's own **OIDC trusted publishing**, so they carried valid provenance. Reported about 20 min later by a third party. CVE-2026-45321. ([GHSA-g7cv-rxg3-hmpx](https://github.com/advisories/GHSA-g7cv-rxg3-hmpx), [postmortem](https://tanstack.com/blog/npm-supply-chain-compromise-postmortem)) | Blocked. Provenance alone would **not** have helped. |

The lesson: 2FA, provenance and trusted publishing all failed at least once. Waiting is the control that works regardless of how the attacker got in.

## Use instead
- Resolve the **newest version on the `latest` line that is at least 7 days old**, and pin it exactly.
- Break the cooldown only to install a version that **fixes an advisory** affecting what you have now, and then only that exact version, through the manager's exclude list.

## Setup (current, copy-pasteable)
Units differ: **npm and poetry use days, pnpm and yarn use minutes, bun uses seconds, and uv and pip use durations.** Full facts are in `data/cooldown.json`.

```ini
# .npmrc  (npm >= 11.10.0; exclusions need >= 11.17.0)
min-release-age=7
min-release-age-exclude[]=@myorg/*
```
```yaml
# pnpm-workspace.yaml  (pnpm >= 10.16.0; pnpm 11 defaults to 1440 = 1 day)
minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  - '@myorg/*'
```
```yaml
# .yarnrc.yml  (Yarn >= 4.10.0; "7d" strings need >= 4.11.0; default 1d since 4.15.0)
npmMinimalAgeGate: 10080
npmPreapprovedPackages:
  - "@myorg/*"
```
```toml
# bunfig.toml  (Bun >= 1.3.0; seconds)
[install]
minimumReleaseAge = 604800
minimumReleaseAgeExcludes = ["@myorg/shared"]
```
```toml
# pyproject.toml  (uv >= 0.9.17 for relative durations)
[tool.uv]
exclude-newer = "7 days"
exclude-newer-package = { my-internal-lib = false }
```
```ini
# pip.conf / pip.ini  (pip >= 26.1 for P<n>D; CLI: --uploaded-prior-to P7D)
[install]
uploaded-prior-to = P7D
```
```toml
# poetry.toml  (Poetry >= 2.4.0; or: poetry config --local solver.min-release-age 7)
[solver]
min-release-age = 7
```

### Install scripts
- npm 12+ blocks dependency lifecycle scripts unless they are allowed in `package.json` → `"allowScripts"`. Review them with `npm approve-scripts --allow-scripts-pending`, then approve exact versions with `npm approve-scripts <pkg>`. On npm 11 or earlier, set `ignore-scripts=true` in `.npmrc` and run the needed builds explicitly.
- pnpm (10+) does not run dependency build scripts by default. pnpm 11 allow-lists them with `allowBuilds:` in `pnpm-workspace.yaml`, and `strictDepBuilds` is on.
- Yarn berry: `enableScripts: false` is the default for third-party postinstall.
- Bun: runs scripts only for `trustedDependencies` (plus Bun's built-in default list). `[install] ignoreScripts = true` disables them all.

### Pinning and lockfiles
- Install exact versions: `npm install pkg@1.2.3 --save-exact` (or `save-exact=true` in `.npmrc`), `pnpm add -E`, `yarn add -E`, `bun add --exact`, `uv add "pkg==1.2.3"`.
- Commit the lockfile. In CI use `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`, `uv sync --locked`.
- Pin GitHub Actions to commit SHAs. Avoid `pull_request_target` workflows that check out PR code (the root cause of the nx and TanStack attacks).

## DO
- Respect an existing cooldown in the repo. If a version is too young, pick an older settled one and tell the user.
- Use `npx package-guidance check <pkg>` to get the settled version before adding a dependency.
- Configure Dependabot or Renovate with the same delay (Dependabot `cooldown: { default-days: 7 }` / Renovate `"minimumReleaseAge": "7 days"`).

## DO NOT
- Do not lower, remove or bypass a configured cooldown (`--min-release-age=0`, `minimumReleaseAge: 0`, `exclude-newer = false`) to "make install work".
- Do not run `npx some-cli@latest` or `pnpm dlx` with unpinned versions in CI.
- Do not use `--dangerously-allow-all-scripts`, `dangerouslyAllowAllBuilds` or `approve-scripts --all` without reviewing them.
- Do not treat provenance or "verified publisher" as proof that a version is safe.

## Migrating existing code
1. Run `npx package-guidance harden --write` (or add the snippet for your manager above).
2. Upgrade the package manager to at least the minimum version listed. Older versions silently ignore the key.
3. Re-lock. If resolution fails because nothing is old enough, wait or pin the previous version. Add an exclude only for internal packages or a reviewed security fix.
