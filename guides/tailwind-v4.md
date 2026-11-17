# Tailwind CSS v4 (CSS-first config)
Applies to: tailwindcss <4, `tailwind` (wrong package name)   ·   Last verified: 2026-11-16   ·   Source: https://tailwindcss.com/docs/upgrade-guide

Tailwind v4 (4.3.x is current) is configured in CSS. `tailwind.config.js`, `@tailwind base/components/utilities`, `postcss-import` and `autoprefixer` are v3 patterns. Do not generate them for new projects.

## Use instead
- Vite: `tailwindcss` + `@tailwindcss/vite`
- PostCSS (Next.js and others): `tailwindcss` + `@tailwindcss/postcss`
- CLI: `@tailwindcss/cli`
- The package is **`tailwindcss`**. The npm package `tailwind` is unrelated and deprecated.

## Setup (current, copy-pasteable)
Vite:
```bash
npm install tailwindcss @tailwindcss/vite
```
```ts
// vite.config.ts
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({ plugins: [tailwindcss()] })
```
```css
/* src/index.css */
@import "tailwindcss";

@theme {
  --font-display: "Satoshi", "sans-serif";
  --color-brand-500: oklch(0.62 0.19 259);
  --breakpoint-3xl: 120rem;
}
```
PostCSS / Next.js:
```bash
npm install tailwindcss @tailwindcss/postcss
```
```js
// postcss.config.mjs
export default { plugins: { "@tailwindcss/postcss": {} } }
```

## DO
- Put design tokens in `@theme { --color-*: ...; --font-*: ...; }`. They become utilities (`bg-brand-500`) and CSS variables.
- Use `@source "../node_modules/some-lib";` to scan extra paths, and `@source inline("...")` to safelist.
- Use `@utility name { ... }` for custom utilities and `@custom-variant` for custom variants.
- Write explicit border colors (`border border-gray-200`). The v4 default is `currentColor`.

## DO NOT
- Do not create `tailwind.config.js` or run `npx tailwindcss init` for a new v4 project.
- Do not write `@tailwind base; @tailwind components; @tailwind utilities;`.
- Do not add `autoprefixer` or `postcss-import`. v4 handles both.
- Do not use the v3 names: `shadow-sm` → `shadow-xs`, `shadow` → `shadow-sm`, `rounded` → `rounded-sm`, `blur` → `blur-sm`, `outline-none` → `outline-hidden`, `ring` → `ring-3`.

## Migrating existing code
1. On a clean branch, run `npx @tailwindcss/upgrade` (Node 20+) and review the diff.
2. To keep a JS config temporarily, load it explicitly with `@config "../tailwind.config.js";`. `corePlugins`, `safelist` and `separator` are not supported.
3. Check browser targets: v4 needs Safari 16.4+, Chrome 111+ and Firefox 128+. If you must support older browsers, stay on 3.4 (npm dist-tag `v3-lts`).
4. To restore the v3 border color globally:
   ```css
   @layer base {
     *, ::after, ::before, ::backdrop, ::file-selector-button {
       border-color: var(--color-gray-200, currentColor);
     }
   }
   ```
