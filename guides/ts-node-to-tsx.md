# ts-node → native Node TypeScript or tsx
Applies to: ts-node (all versions), `node --loader ts-node/esm`   ·   Last verified: 2026-11-16   ·   Source: https://nodejs.org/api/typescript.html

ts-node has had no release since 10.9.2 (Dec 2023) and handles ESM poorly. Node now strips TypeScript types itself:
- On by default (no flag) since **Node 22.18 / 23.6**. The ExperimentalWarning is gone since 22.18 / 24.3.
- **Stable** since 24.12 / 25.2. Current LTS lines: Node 26 ("Lithium"), 24 ("Krypton") and 22 ("Jod").
- `--experimental-strip-types` is no longer needed. `--experimental-transform-types` was **removed in Node 26**.

## Use instead
- `node file.ts` for erasable-only TypeScript (types, interfaces, `import type`, generics). No type-checking.
- `tsx` when you need enums, runtime namespaces, parameter properties, decorators, `.tsx`, or tsconfig `paths`.
- `tsc --noEmit` (or your editor or CI) for type-checking. Neither runner type-checks.

## Setup (current, copy-pasteable)
Native (Node 22.18+):
```json
// tsconfig.json
{
  "compilerOptions": {
    "noEmit": true,
    "target": "esnext",
    "module": "nodenext",
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true
  }
}
```
```json
// package.json
{ "type": "module", "scripts": { "start": "node src/index.ts", "dev": "node --watch src/index.ts", "typecheck": "tsc --noEmit" } }
```
tsx:
```bash
npm install -D tsx
npx tsx src/index.ts
npx tsx watch src/index.ts
node --import tsx src/index.ts      # use as a loader
```

## DO
- Write relative imports with the real extension: `import { x } from "./util.ts"`.
- Use `import type { T }` for type-only imports (`verbatimModuleSyntax` enforces it).
- Replace tsconfig `paths` aliases with package.json subpath imports (`"imports": { "#lib/*": "./src/lib/*" }`) for native Node, or keep tsx.

## DO NOT
- Do not add `ts-node` or `--loader ts-node/esm` to new projects.
- Do not use `enum`, `namespace` with runtime code, parameter properties (`constructor(private x)`) or legacy decorators with native Node. They throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Use `as const` objects and explicit fields.
- Do not pass `--experimental-transform-types` (removed in 26) or `--experimental-strip-types` (unnecessary).
- Do not expect native stripping to work for `.ts` files inside `node_modules`. Publish compiled JS.

## Migrating existing code
1. `npm uninstall ts-node @types/ts-node`. Remove the `ts-node` block from `tsconfig.json`.
2. Scripts: `ts-node src/x.ts` becomes `node src/x.ts` (if erasable) or `tsx src/x.ts`. `ts-node-dev` / `nodemon -x ts-node` becomes `node --watch` or `tsx watch`.
3. Add `"erasableSyntaxOnly": true` and run `tsc --noEmit`. The errors list exactly what to rewrite for native Node, or which files need tsx.
4. Mocha/AVA: replace `--require ts-node/register` with `--import tsx`. Jest: use its own transformer, or move to Vitest.
