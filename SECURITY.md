# Security policy

package-guidance runs inside coding agents and decides what they install, so we treat issues in it seriously.

## Reporting a vulnerability

Please **do not open a public issue.** Report privately through [GitHub security advisories](https://github.com/harshpreet931/package-guidance/security/advisories/new). We aim to acknowledge reports within 3 days.

In scope, for example:
- a way to make the hook **allow** an install it should block, or to make the CLI recommend a malicious or vulnerable version
- prompt injection through registry-controlled text (deprecation messages, advisory titles) that reaches the agent unquoted
- command injection in the hook or its pre-filter
- anything that makes `harden` write something other than the documented cooldown setting

Out of scope: a curated recommendation you disagree with. Open a [bad recommendation](https://github.com/harshpreet931/package-guidance/issues/new?template=bad-recommendation.yml) issue instead.

## How we protect our own supply chain

- No runtime dependencies.
- The skill and hook run an exact pinned version of this tool, never `@latest`.
- GitHub Actions are pinned to commit SHAs. Dependabot waits out a 7-day cooldown.
- Releases are published from CI with npm provenance (trusted publishing). No long-lived npm token exists.
