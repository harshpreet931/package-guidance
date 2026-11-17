# Create React App → Vite (or a framework)
Applies to: create-react-app, react-scripts (all versions)   ·   Last verified: 2026-11-16   ·   Source: https://react.dev/blog/2025/02/14/sunsetting-create-react-app

The React team deprecated CRA on 2025-02-14. It has no maintainers. Never scaffold with `create-react-app` or add `react-scripts`.

## Use instead
- **Client-side SPA:** Vite (v8 current; needs Node 20.19+ or 22.12+).
- **SSR / RSC / full-stack:** Next.js (`npx create-next-app@latest`) or React Router framework mode (`npx create-react-router@latest`).

## Setup (current, copy-pasteable)
```bash
npm create vite@latest my-app -- --template react-ts
cd my-app && npm install && npm run dev
```

## DO
- Use `import.meta.env.VITE_*` for client env vars, and type them through `vite/client`.
- Keep `index.html` at the project root with a module script tag.
- Use Vitest for tests (see `jest-to-vitest`).

## DO NOT
- Do not run `npx create-react-app`, `npm i react-scripts`, or "eject".
- Do not use `process.env.REACT_APP_*` in Vite code. It is undefined.
- Do not copy CRA's `%PUBLIC_URL%` placeholders into Vite's `index.html`.

## Migrating existing code
1. Install:
   ```bash
   npm uninstall react-scripts
   npm install -D vite @vitejs/plugin-react
   ```
2. Add `vite.config.ts`:
   ```ts
   import { defineConfig } from 'vite'
   import react from '@vitejs/plugin-react'

   export default defineConfig({
     plugins: [react()],
     server: { port: 3000 },     // keep CRA's port if scripts or docs depend on it
     build: { outDir: 'build' }, // keep CRA's output dir if deploys expect it
   })
   ```
3. Move `public/index.html` to `./index.html`. Remove `%PUBLIC_URL%` (use `/favicon.ico`) and add, before `</body>`:
   ```html
   <script type="module" src="/src/index.tsx"></script>
   ```
   Files in `public/` are still served from `/`.
4. Scripts in `package.json`:
   ```json
   { "scripts": { "dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview" } }
   ```
5. Env vars: rename `REACT_APP_FOO` to `VITE_FOO`, and `process.env.REACT_APP_FOO` to `import.meta.env.VITE_FOO`. Add `/// <reference types="vite/client" />` in `src/vite-env.d.ts`.
6. Vite only treats `.jsx`/`.tsx` files as JSX. Rename `.js` files that contain JSX.
7. `tsconfig.json`: set `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"jsx": "react-jsx"`, `"types": ["vite/client"]`.
8. SVG as components (`import { ReactComponent } from './logo.svg'`) is a CRA feature. Use `vite-plugin-svgr` and `import Logo from './logo.svg?react'`.
9. Tests: replace `react-scripts test` with Vitest (`jest-to-vitest` guide).
10. Delete `react-app-env.d.ts`, `reportWebVitals` (optional), and the `eslintConfig: "react-app"` block. Set up flat ESLint config instead (`eslint-flat-config` guide).
