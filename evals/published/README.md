# Published eval results

Scored outputs of eval runs: reports, summaries and chart data. Raw session transcripts are not published because they contain local machine details. The harness, prompts, fixtures and scorer in this directory are everything needed to reproduce a run.

| Run | Agent | Setup | Report |
|---|---|---|---|
| 2026-11-16 | Claude Code, Sonnet 5.5 | 31 tasks × 2 seeds × {plain, package-guidance skill + hook}; guarded mode | [report](2026-11-16-claude-sonnet/report.md) |
| 2026-11-16 | Claude Code, Opus 5.5 | first 15 tasks × 1 seed × {plain, package-guidance skill + hook}; guarded mode | [report](2026-11-16-claude-opus/report.md) |
| 2026-11-16 | `kimi-latest` via an OpenAI-compatible gateway | choice eval (commands only, no shell): 31 tasks × 2 seeds × {plain, registry-lookup tool, package-guidance} | [report](2026-11-16-kimi-choice/report.md) |

## Scoring changes

- **2026-11-17:** advisories are now checked on the version that would actually be installed (lockfile, exact pin, or the highest match at run time). Before, unpinned and ranged dependencies were checked at the *lowest* version their range allowed, which flagged e.g. `npm install zod` for advisories in zod 1.0.0. All three runs were rescored from their saved registry snapshots, so only advisory counts changed: Sonnet baseline 11 → 7, Opus baseline 4 → 3, Kimi baseline 85 → 5. Fresh-version and outdated counts did not change. Runs that failed at the endpoint are now excluded from dependency metrics instead of counting as clean.
