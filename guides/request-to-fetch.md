# request / node-fetch → native fetch
Applies to: request, request-promise, request-promise-native, node-fetch, @types/node-fetch   ·   Last verified: 2026-11-16   ·   Source: https://nodejs.org/api/globals.html#fetch

`request` has been deprecated since 2020 (request/request#3142). Global `fetch` has been unflagged since Node 18 and stable since Node 21, and every supported Node line (22, 24, 26) has it. You don't need an HTTP dependency for ordinary requests.

## Use instead
- `fetch` (native): Node 18+, browsers, Deno, Bun.
- `ky`, a small fetch wrapper, if you want retries, hooks and `.json()` shortcuts.
- `ofetch` for universal fetch with automatic JSON parsing (Nuxt/unjs).
- `undici` only when you need its lower-level API (Agent, pools, ProxyAgent).

## Setup (current, copy-pasteable)
```ts
const res = await fetch("https://api.example.com/items?" + new URLSearchParams({ page: "2" }), {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
const items = await res.json();
```
POST JSON:
```ts
await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```
Form upload (multipart):
```ts
import { openAsBlob } from "node:fs";
const form = new FormData();
form.append("file", await openAsBlob("./report.pdf"), "report.pdf");
await fetch(url, { method: "POST", body: form }); // don't set Content-Type by hand
```
Stream a download to disk:
```ts
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
const res = await fetch(url);
await pipeline(Readable.fromWeb(res.body!), createWriteStream("out.bin"));
```

## DO
- Always check `res.ok`. fetch does **not** reject on 4xx or 5xx.
- Use `AbortSignal.timeout(ms)` for timeouts. fetch has no `timeout` option.
- Use `URLSearchParams` for query strings (`qs:` in request).

## DO NOT
- Do not install `request`, `request-promise`, `node-fetch` or `@types/node-fetch` in Node 18+ code.
- Do not install `form-data` or `abort-controller` polyfills. `FormData`, `Blob` and `AbortController` are global.
- Do not `import fetch from "node-fetch"` in new code. node-fetch v3 is ESM-only and has had no release since 2023.

## Migrating existing code
| request | fetch |
|---|---|
| `request(url, cb)` | `const res = await fetch(url)` |
| `json: true` | `await res.json()` / `JSON.stringify` + header |
| `qs: { a: 1 }` | `url + "?" + new URLSearchParams({ a: "1" })` |
| `form: {...}` | `body: new URLSearchParams({...})` |
| `formData: {...}` | `body: formData` (global `FormData`) |
| `timeout: 5000` | `signal: AbortSignal.timeout(5000)` |
| `auth: { bearer }` | `headers: { Authorization: "Bearer …" }` |
| `resolveWithFullResponse` | `res.status`, `res.headers.get(...)` |
| `simple: true` (reject non-2xx) | `if (!res.ok) throw …` |
| `proxy:` | undici `ProxyAgent` passed as `dispatcher`, or `NODE_USE_ENV_PROXY=1` on recent Node |

Remove `@types/request` and `@types/node-fetch`. The fetch types come from `@types/node` / `lib.dom`.
