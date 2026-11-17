# ESLint flat config (eslint.config.js)
Applies to: eslint <10, .eslintrc.*, .eslintignore, tslint, babel-eslint   ·   Last verified: 2026-11-16   ·   Source: https://eslint.org/docs/latest/use/configure/migration-guide

ESLint **v10** (2026-02-06) is the only supported major, and v9 hit EOL on 2026-08-06. v10 **removed eslintrc entirely**: `.eslintrc.*`, `.eslintignore`, `ESLINT_USE_FLAT_CONFIG`, `--env`, `--no-eslintrc` and `/* eslint-env */` comments (now errors). Node requirement: `^20.19.0 || ^22.13.0 || >=24`.

## Use instead
- `eslint.config.js` (or `.mjs`, `.cjs`, `.ts`; TS configs need `jiti` >= 2.2.0) at the project root.
- `defineConfig()` and `globalIgnores()` from `"eslint/config"`.
- TypeScript: `typescript-eslint` (replaces TSLint and `@typescript-eslint/*` wiring).

## Setup (current, copy-pasteable)
```bash
npm install -D eslint @eslint/js globals typescript-eslint
```
```js
// eslint.config.js
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist/", "coverage/"]),
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  tseslint.configs.recommended,
]);
```
Interactive alternative: `npm init @eslint/config@latest`.

## DO
- Import plugins and parsers as objects: `plugins: { react }`, `languageOptions: { parser }`.
- Use `files` globs instead of `overrides`, and `ignores` / `globalIgnores()` instead of `.eslintignore`.
- Get globals from the `globals` package instead of `env`.
- In monorepos, note that v10 looks up `eslint.config.*` starting from each linted file's directory, so nested configs work.

## DO NOT
- Do not create `.eslintrc.json`, `.eslintrc.js` or `.eslintignore`. v10 ignores them.
- Do not set `ESLINT_USE_FLAT_CONFIG` or write `/* eslint-env node */`.
- Do not install `eslint@8` or `eslint@9`. Both are EOL, and 8.x is flagged deprecated on npm.
- Do not install `tslint`, `babel-eslint` or `eslint-plugin-node`. Use `typescript-eslint`, `@babel/eslint-parser` and `eslint-plugin-n` instead.

## Migrating existing code
1. Convert: `npx @eslint/migrate-config .eslintrc.json`. Treat the output as a starting point. `.eslintrc.js` converts less reliably.
2. Shareable configs that still only ship eslintrc format can be wrapped:
   ```js
   import { FlatCompat } from "@eslint/eslintrc";
   import { defineConfig } from "eslint/config";
   const compat = new FlatCompat({ baseDirectory: import.meta.dirname });
   export default defineConfig([...compat.extends("eslint-config-legacy-thing")]);
   ```
   Prefer each plugin's native flat export (`plugin.configs["flat/recommended"]` or `.configs.recommended`) when one exists.
3. Map `env: { browser: true }` to `languageOptions: { globals: globals.browser }`.
4. Map `ignorePatterns` to `globalIgnores([...])`. Reuse `.gitignore` with `includeIgnoreFile()` from `@eslint/compat`.
5. Delete the old `.eslintrc*` and `.eslintignore`, the `eslintConfig` key in `package.json`, and any `--ext` flags in lint scripts (they are not needed when `files` globs cover the extensions).
6. Upgrade: `npm install -D eslint@10 @eslint/js@10` and fix the new `eslint:recommended` findings.
