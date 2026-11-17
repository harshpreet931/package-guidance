# Changelog

## 0.1.0 (unreleased)

First release.

- `check`: a verdict per package with a pinned install line. It picks the newest settled version (7-day cooldown by default), blocks hallucinated, deprecated, malicious and known-vulnerable packages, flags slopsquat-like packages, and points to curated replacements and migration guides.
- `scan`: audits the dependencies a project already declares (npm, PyPI, uv, Poetry).
- `guide`: 14 migration guides written for agents (CRA→Vite, Tailwind v4, ESLint flat config, Pydantic v2, uv, the supply-chain cooldown, …).
- `harden`: writes a release-age cooldown into the repo's own npm, pnpm, Yarn, Bun, uv or Poetry config. It never lowers an existing one.
- `hook`: a Claude Code PreToolUse hook that denies bad installs and rewrites the command with safe pins. It never auto-approves and fails open.
- Agent skill and Claude Code plugin.
- 68 curated entries (47 npm, 21 PyPI) with primary sources, plus the e18e module-replacements dataset.
- Eval harness with an independent scorer.
