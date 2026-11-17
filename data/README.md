# Contributing to the knowledge base

`data/` holds curated facts that the CLI and agent skill load at runtime:

- `entries/<ecosystem>/<id>.json`: one trap per file (`npm` or `pypi`).
- `cooldown.json`: release-age cooldown config per package manager. `harden` writes it into user repos, so it must be exact.
- Long migration guides live in `../guides/<id>.md` (format: see any existing guide).

## Adding an entry

1. **Verify live. Never from memory.**
   - npm: `curl -s https://registry.npmjs.org/<pkg> | jq '{tags: ."dist-tags", dep: .versions[."dist-tags".latest].deprecated}'`
   - PyPI: `curl -s https://pypi.org/pypi/<pkg>/json | jq '.info | {version, classifiers, summary}'`
   - Advisories: `https://api.osv.dev/v1/query` or `https://github.com/advisories`
   - Status claims need a primary source: the maintainer's blog or README, official docs, a changelog, or a GitHub advisory. Do not cite third-party blogs.
   - If you cannot verify a claim, leave it out.
2. **Create `entries/<ecosystem>/<id>.json`** (the filename equals `id`, kebab-case):
   ```json
   {
     "id": "request",
     "ecosystem": "npm",
     "packages": ["request", "request-promise"],
     "versions": "*",
     "status": "deprecated",
     "severity": "block",
     "summary": "One or two factual sentences: what is wrong, since when, what to do.",
     "replacements": [
       { "name": "fetch", "kind": "native", "when": "Node 18+" },
       { "name": "ky", "kind": "package", "install": "npm install ky" }
     ],
     "guide": "request-to-fetch",
     "tags": ["http"],
     "source": "https://github.com/request/request/issues/3142",
     "last_verified": "YYYY-MM-DD"
   }
   ```
   - `status`: `deprecated` | `sunset` | `superseded` | `outdated-major` | `prefer-native` | `caution`
   - `versions`: a simple comparator set (`"*"`, `"<4"`, `">=1 <2"`). Use `outdated-major` with `"<N"` when old-major patterns are wrong now.
   - `replacements[].kind`: `package` | `native` | `tool` | `config`. Include `install` only if it is copy-pasteable and current.
   - `guide`: optional. It must match an existing `guides/<id>.md`.
3. **Pick severity honestly.**
   - `block`: clear-cut only. Registry-deprecated, archived or unmaintained with no future, security-dead, a removed or renamed package, or a stub. The hook **denies** installs on `block`.
   - `warn`: a real problem with a judgement call (maintenance mode, a superseded major, unfixed advisories, a protestware history).
   - `info`: preference or opportunity ("native API exists", "Ruff is faster"). Opinions are never `block`.
4. **Write dated, checkable facts.** Prefer "no release since 10.9.2 (Dec 2023)" to "old". Avoid model names, prices and other facts that go stale fast.
5. **Validate:**
   ```bash
   python3 -m json.tool data/entries/npm/<id>.json > /dev/null
   node bin/package-guidance.js check <pkg>          # add --pypi for PyPI
   ```

## Updating `cooldown.json`

- Record for each manager: config file, key, **unit** (days, minutes, seconds or duration; they differ), minimum PM version, default on or off (and since which version), example, exclude key, and source and changelog URLs.
- Check the official settings docs **and** the release notes. Defaults change: pnpm 11 and Yarn 4.15 turned cooldowns on by default.
- Use `null` when a manager has no such feature. Never guess.

## Re-verification

Bump `last_verified` only after re-checking the source and registry. Remove or downgrade entries whose facts changed (for example, a dist-tag trap that has been fixed).

### Names that are not packages

Some entries exist because agents try to install something that is not a package at all, such as `imp` or `pkg_resources` on PyPI. Mark these with `"not_on_registry": true` so that the weekly live check expects a 404 instead of reporting drift.
