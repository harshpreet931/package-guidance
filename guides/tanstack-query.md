# react-query → @tanstack/react-query v5
Applies to: react-query (all), @tanstack/react-query <5   ·   Last verified: 2026-11-16   ·   Source: https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5

The `react-query` package stopped at v3 (2023). The library is `@tanstack/react-query`, and v5 (5.107.x) is current. v5 requires **React 18+**.

## Use instead
- `@tanstack/react-query`, plus optionally `@tanstack/react-query-devtools` and `@tanstack/eslint-plugin-query`.

## Setup (current, copy-pasteable)
```bash
npm install @tanstack/react-query
npm install -D @tanstack/react-query-devtools @tanstack/eslint-plugin-query
```
```tsx
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } })

export function App() {
  return <QueryClientProvider client={queryClient}><Todos /></QueryClientProvider>
}

function Todos() {
  const qc = useQueryClient()
  const { data, isPending, error } = useQuery({
    queryKey: ['todos'],
    queryFn: () => fetch('/api/todos').then(r => r.json()),
  })
  const add = useMutation({
    mutationFn: (title: string) => fetch('/api/todos', { method: 'POST', body: JSON.stringify({ title }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['todos'] }),
  })
  if (isPending) return <p>Loading…</p>
  if (error) return <p>{error.message}</p>
  return <ul>{data.map((t: { id: string; title: string }) => <li key={t.id}>{t.title}</li>)}</ul>
}
```

## DO
- Use the **single object signature** everywhere: `useQuery({ queryKey, queryFn })` and `qc.invalidateQueries({ queryKey })`.
- Use `isPending` for "no data yet". `isLoading` is now `isPending && isFetching`.
- Use `useSuspenseQuery` for Suspense, and `HydrationBoundary` for SSR hydration.
- Give infinite queries an explicit `initialPageParam` and a `getNextPageParam`.

## DO NOT
- Do not install `react-query` or import from `'react-query'`.
- Do not pass `onSuccess`, `onError` or `onSettled` to `useQuery`. They were removed (mutations keep them). Use `useEffect` on `data` or handle it in `queryFn`.
- Do not use `cacheTime`, `keepPreviousData: true`, `useErrorBoundary`, `suspense: true` or `<Hydrate>`.

## Migrating existing code
| v3 / v4 | v5 |
|---|---|
| `import … from 'react-query'` | `from '@tanstack/react-query'` |
| `useQuery(key, fn, opts)` | `useQuery({ queryKey, queryFn, ...opts })` |
| `cacheTime` | `gcTime` |
| `status === 'loading'` / `isLoading` | `status === 'pending'` / `isPending` |
| `keepPreviousData: true` | `placeholderData: keepPreviousData` (import the helper) |
| `isPreviousData` | `isPlaceholderData` |
| `useErrorBoundary` | `throwOnError` |
| `suspense: true` | `useSuspenseQuery(...)` |
| `<Hydrate>` / `useHydrate` | `<HydrationBoundary>` |
| `ReactQueryDevtools` from `react-query/devtools` | from `@tanstack/react-query-devtools` |

Automate the signature change with the official `remove-overloads` codemod (see the migration guide for the exact command). Use the `tsx` parser for TS files, then run Prettier or ESLint.
