# Moment.js → date-fns (or Temporal)
Applies to: moment, moment-timezone (new code)   ·   Last verified: 2026-11-16   ·   Source: https://momentjs.com/news/

Moment is a **legacy project in maintenance mode** (status update 2026-08-17). It gets security fixes and tz data only, and its mutable API will not change. Do not add it to new code.

## Use instead
- **date-fns** (v4): pure functions on native `Date`, tree-shakeable. Time zones via `@date-fns/tz` (`TZDate`).
- **Temporal** (native): TC39 **Stage 4**. Shipped in Firefox 139 (2025-05), Chrome 144 (2026-01) and Node 26 (2026-05). Not yet in Safari, so use `temporal-polyfill` in browsers where it is missing.
- **Day.js** if you want Moment's chainable API in 2 kB. **Luxon** for Intl-based zones.

## Setup (current, copy-pasteable)
```bash
npm install date-fns @date-fns/tz
```
```ts
import { format, addDays, differenceInCalendarDays, parseISO, isBefore } from "date-fns";
import { TZDate } from "@date-fns/tz";

const due = addDays(parseISO("2026-11-16"), 7);
format(due, "yyyy-MM-dd");                       // "2026-11-23"
differenceInCalendarDays(due, new Date());
const ny = new TZDate(2026, 10, 16, 9, 0, "America/New_York");
format(ny, "yyyy-MM-dd HH:mm xxx");             // "2026-11-16 09:00 -05:00"
```
Temporal (Node 26+, Chrome 144+, Firefox 139+):
```ts
const today = Temporal.Now.plainDateISO();
const due = today.add({ days: 7 });
const meeting = Temporal.ZonedDateTime.from("2026-11-16T09:00[America/New_York]");
meeting.withTimeZone("Europe/Berlin").toString();
```
Polyfill where needed: `npm install temporal-polyfill`, then `import { Temporal } from "temporal-polyfill"`.

## DO
- Use **Unicode tokens** in date-fns: `yyyy` (not `YYYY`), `dd` (not `DD`). `YYYY` is the week-numbering year and gives wrong dates around New Year.
- Use `parseISO` for ISO strings and `parse(str, fmt, ref)` for custom formats.
- Use `Intl.DateTimeFormat` / `toLocaleDateString` for localized display without a library.

## DO NOT
- Do not `npm install moment` or `moment-timezone` for new features.
- Do not use `@js-temporal/polyfill` for production. It is alpha; prefer `temporal-polyfill`.
- Do not mutate dates in place (Moment habit). date-fns and Temporal return new values.

## Migrating existing code
| Moment | date-fns | Temporal |
|---|---|---|
| `moment()` | `new Date()` | `Temporal.Now.zonedDateTimeISO()` |
| `moment(str)` | `parseISO(str)` | `Temporal.PlainDate.from(str)` |
| `m.format("YYYY-MM-DD")` | `format(d, "yyyy-MM-dd")` | `d.toString()` |
| `m.add(1, "day")` | `addDays(d, 1)` | `d.add({ days: 1 })` |
| `m.diff(o, "days")` | `differenceInDays(d, o)` | `o.until(d).days` (PlainDate) |
| `m.startOf("month")` | `startOfMonth(d)` | `d.with({ day: 1 })` |
| `m.isBefore(o)` | `isBefore(d, o)` | `Temporal.PlainDate.compare(d, o) < 0` |
| `m.fromNow()` | `formatDistanceToNow(d, { addSuffix: true })` | `Intl.RelativeTimeFormat` |
| `moment.tz(iso, zone)` | `new TZDate(iso, zone)` | `Temporal.ZonedDateTime.from(...)` |

Migrate module by module, convert at the boundaries (`m.toDate()`), then remove `moment` and its locale imports from the bundle.
