# node-sass → sass (Dart Sass)
Applies to: node-sass (all versions)   ·   Last verified: 2026-11-16   ·   Source: https://sass-lang.com/blog/libsass-is-deprecated/

`node-sass` (LibSass) is deprecated on npm ("Node Sass is no longer supported") and its repository is archived. It needs native builds that break on new Node versions. Dart Sass is the only maintained implementation (`sass` 1.108.x).

## Use instead
- `sass`: pure JS, works everywhere.
- `sass-embedded`: same compiler run as a native Dart binary, faster for large projects. Vite and sass-loader pick it up automatically.

## Setup (current, copy-pasteable)
```bash
npm uninstall node-sass
npm install -D sass          # or: npm install -D sass-embedded
```
- **Vite**: nothing else to do. `.scss` imports work once `sass` or `sass-embedded` is installed.
- **Next.js**: built-in. Install `sass` and import `.scss` / `.module.scss`.
- **webpack**: keep `sass-loader` and remove any `implementation: require("node-sass")` option.
- **CLI**: `npx sass src/styles.scss dist/styles.css --style=compressed`

## DO
- Use the module system: `@use "variables" as v;` and `@forward`, not `@import`.
- Use namespaced built-ins: `@use "sass:math"; math.div(10px, 2)`, `@use "sass:color"; color.adjust(...)`.
- Use the modern JS API (`sass.compile` / `compileAsync`) in custom tooling.

## DO NOT
- Do not install `node-sass` or try to `npm rebuild node-sass` for a new Node version.
- Do not write new `@import` rules. They have been officially deprecated since Dart Sass 1.80.0 and will be removed in Dart Sass 3.
- Do not use `/` for division (`$a / 2`). Use `math.div`.
- Do not call the legacy `render()` / `renderSync()` API. It is deprecated (warning `legacy-js-api`).

## Migrating existing code
1. Swap the packages (above) and run the build. Most LibSass code compiles unchanged, with deprecation warnings.
2. Fix division and `@import` automatically:
   ```bash
   npx sass-migrator division --migrate-deps src/styles.scss
   npx sass-migrator module --migrate-deps src/styles.scss
   ```
3. Replace `~` webpack import prefixes (`@use "~bootstrap/scss/..."`) with plain package paths where your bundler supports it (Vite does; configure `loadPaths` otherwise).
4. Silence a deprecation temporarily only with `silenceDeprecations: ["import"]` in the Sass options while you migrate. Do not leave it permanently.
