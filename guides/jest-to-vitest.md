# Jest → Vitest (Vite projects)
Applies to: jest, ts-jest, babel-jest in projects that already use Vite   ·   Last verified: 2026-11-16   ·   Source: https://vitest.dev/guide/migration/jest

Jest (30.x) is maintained. **Do not rewrite a working non-Vite Jest suite for its own sake.** In a Vite project, Vitest reuses `vite.config`, handles ESM and TS without transforms, and has a Jest-compatible API. Vitest 5 requires **Vite >= 6.4 and Node >= 22.12**.

## Use instead
- `vitest` (5.x) + `jsdom` or `happy-dom` for DOM tests.
- `@testing-library/react` + `@testing-library/jest-dom/vitest` for React.
- `@vitest/coverage-v8` for coverage.

## Setup (current, copy-pasteable)
```bash
npm install -D vitest jsdom @testing-library/react @testing-library/dom @testing-library/jest-dom
```
```ts
// vite.config.ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,              // only if you want Jest-style globals
    setupFiles: ['./src/test/setup.ts'],
  },
})
```
```ts
// src/test/setup.ts
import '@testing-library/jest-dom/vitest'
```
```json
{ "scripts": { "test": "vitest", "test:run": "vitest run", "coverage": "vitest run --coverage" } }
```
With `globals: true`, add `"types": ["vitest/globals"]` to tsconfig.

## DO
- `import { describe, it, expect, vi } from 'vitest'` (explicit imports, recommended).
- Keep `vi.mock`, `vi.unmock` and `vi.hoisted` at the **top level** of the file. In Vitest 5, nested calls throw.
- Make `vi.mock` factories return every export explicitly, including `default`.

## DO NOT
- Do not add Jest to a new Vite project, and do not install `ts-jest` / `babel-jest` alongside Vitest.
- Do not use `done` callbacks. Return a Promise or use `async`.
- Do not rely on Jest legacy fake timers. Vitest supports only modern timers.

## Migrating existing code
| Jest | Vitest |
|---|---|
| `jest.fn()` / `jest.spyOn()` | `vi.fn()` / `vi.spyOn()` |
| `jest.mock('m', () => value)` | `vi.mock('m', () => ({ default: value }))` |
| `jest.requireActual('m')` | `await vi.importActual('m')` |
| `jest.useFakeTimers()` | `vi.useFakeTimers()` |
| `jest.setTimeout(5000)` | `vi.setConfig({ testTimeout: 5_000 })` |
| `jest.Mock` type | `import type { Mock } from 'vitest'` |
| `JEST_WORKER_ID` | `VITEST_POOL_ID` |

Behavior differences to check:
- `mockReset()` restores the **original implementation** in Vitest (Jest resets to `undefined`).
- Hooks run as a stack. For Jest order, set `test.sequence.hooks: 'list'`.
- Vitest 5 defaults `clearMocks: true`.
- With `globals: false`, Testing Library does not auto-cleanup. Call `cleanup()` in `afterEach` or enable globals.

Steps: remove `jest.config.*`, `babel.config.*` (if only used by Jest), `ts-jest`, `babel-jest` and `@types/jest`. Search-and-replace `jest.` with `vi.`, run `vitest run`, and fix the mock factories.
