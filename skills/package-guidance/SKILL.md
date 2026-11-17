---
name: package-guidance
description: |
  Dependency decision procedure. MANDATORY: run BEFORE adding, installing, upgrading or scaffolding with any npm or PyPI package (npm/pnpm/yarn/bun add or install, npx/create-*, pip/uv/poetry add, editing package.json, pyproject.toml or requirements.txt). Do NOT skip: your training data contains outdated majors, deprecated packages and package names that do not exist, and the newest release of a package is exactly where supply-chain worms land.
  Trigger for: starting a new project, "add X", choosing a library, upgrading deps, fixing a vulnerable/deprecated dependency, auditing dependencies, migration questions (CRA, Tailwind v4, ESLint flat config, Pydantic v2, uv, ...).
  DO NOT trigger for: code changes that add no dependency, installing from an existing lockfile (`npm ci`, `uv sync`), or non-npm/PyPI ecosystems.
---

# Package Guidance

Agents install fresh versions within hours of release, and so do worms. Before any dependency enters a project, decide it with live registry data, not memory.

## The decision procedure

1. **Need it?** Prefer the platform: `fetch`, `crypto.randomUUID()`, `structuredClone`, `node:util.styleText`, `node --env-file`, `zoneinfo`, `tomllib`. Fewer dependencies are fewer attack surfaces.
2. **Right package?** Not deprecated, sunset or superseded. The check below knows the common traps.
3. **Real package?** If the registry has never heard of it, it was hallucinated. Never install it, and never "fix" the name by guessing something similar. Find the real name in the official docs.
4. **Settled version.** Use the newest release that has been public for at least the cooldown (default 7 days). The only exception is when a newer release fixes an advisory on the older one.
5. **No known advisories** on the version you pin.
6. **Respect project policy.** If the repo configures a release-age cooldown (`min-release-age`, `minimumReleaseAge`, `npmMinimalAgeGate`, `exclude-newer`), keep it. **Never lower, remove or bypass it** to make an install succeed.
7. **Pin exactly** (`pkg@1.2.3`, `pkg==1.2.3`) and commit the lockfile.

## Step 1. Check before you install

Check every package you are about to add, in one call:

```sh
npx -y package-guidance@0.1.0 check <pkg> [<pkg>@<range> ...] --json
```

- For Python add `--pypi` and use pip syntax: `check --pypi "pydantic>=2" fastapi`.
- Pass ranges only when the project needs them, e.g. a peer dependency, or an existing major you are not upgrading.
- `--json` returns `install`, a ready-to-run command with exact pins chosen by the procedure above. **Use it verbatim.**
- The command needs network access to registry.npmjs.org, api.deps.dev, api.osv.dev and pypi.org. If it fails or is sandboxed, follow the procedure manually using `npm view <pkg> time --json` / `pip index versions <pkg>`.

Act on each result's `verdict`:

| verdict | do this |
|---|---|
| `ok` | Install `version` exactly. |
| `caution` | Fine to install, but read `message` first: it names a known risk (protestware history, beta-only major, maintenance mode). |
| `outdated` | Use the current major (`version`) unless the project truly needs the old one. Read the `guide` if one is given: majors change setup. |
| `replace` | Use one of `alternatives` instead. Prefer a native API when one is listed. |
| `deprecated` | Do not install. Use `alternatives`, or follow the `guide`. |
| `vulnerable` | If `fixedIn` is set, install that version. Otherwise choose an alternative. |
| `not-found` / `malicious` | Do not install. Do not guess similar names. Tell the user. |
| `young` | Either the version is inside the cooldown (use `version`, the settled one), or the whole package is brand new: confirm the exact name in official docs. |
| `unproven` | Almost no downloads. Slopsquats look like this: confirm the exact name in official docs before installing. |

## Step 2. Use current setup patterns

When a result carries a `guide`, or when you scaffold anything with a framework, read the guide before writing config. Version jumps change setup (Tailwind v4 has no `tailwind.config.js` by default; ESLint 9+ uses `eslint.config.js`):

```sh
npx -y package-guidance@0.1.0 guide <id>        # print one guide
npx -y package-guidance@0.1.0 guide "<query>"   # search: "tailwind setup", "react scaffold", "python lint"
```

## Step 3. Existing projects

To audit what a project already declares, or before upgrading dependencies, run `npx -y package-guidance@0.1.0 scan --json` (add `--pypi` for Python), then fix the `block` results first. To make the package manager enforce a cooldown for everyone in the repo, run `npx -y package-guidance@0.1.0 harden`, and add `--write` only if the user agrees to the config change.

## Step 4. Disclose

When this skill changed which package or version you used, end your response with a short `### Package Guidance` section. Write one bullet per changed decision, e.g. "- Pinned `next@16.4.5` instead of `16.4.6` (published 6d ago, inside the 7-day cooldown)" or "- Used native `fetch` instead of `request` (deprecated)". Only report what the check actually returned this turn. Never reconstruct verdicts from memory.
