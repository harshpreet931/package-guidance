# Contributing

Thanks for helping agents pick better dependencies. The most valuable contributions are usually **data**: a package agents keep getting wrong, or a recommendation of ours that is wrong.

## Report a bad recommendation

If package-guidance blocked something it shouldn't have, or missed something it should have caught, open a [bad recommendation](https://github.com/harshpreet931/package-guidance/issues/new?template=bad-recommendation.yml) issue with the command and output. A wrong deny from the hook is treated as a high-priority bug.

## Add or fix a curated entry

See [`data/README.md`](data/README.md). In short:

1. Verify against the live registry and a **primary source**: maintainer announcement, official docs, changelog or advisory. Never from memory or third-party blogs.
2. Add `data/entries/<npm|pypi>/<id>.json` and, for a real migration, a guide in `guides/<id>.md`.
3. Use `severity: "block"` only for clear-cut cases (unmaintained, archived, security-dead). Matters of taste are `info`.
4. Run `node scripts/validate-data.mjs` and `node bin/package-guidance.js check <pkg>` to see how it reads.

## Code

```sh
npm ci --ignore-scripts
npm test                 # builds, then runs the offline test suite
node bin/package-guidance.js check react tailwindcss@3
```

- Zero runtime dependencies. Discuss any new one in an issue first.
- Anything that changes what the hook blocks needs a test, including one proving innocent commands are still allowed (see `test/shell.test.mjs`).
- Keep the CLI's human output scannable: the action comes first in every message.
- How the pieces fit together: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Releasing (maintainers)

`npm version <patch|minor|major>` updates every pinned version reference (skill, plugin, CLI). Then `git push --follow-tags`. The release workflow publishes to npm with provenance via trusted publishing.
