# package-guidance site: design

This replaces the earlier "release-age ruler" synthesis. It was written before the rebuild, after a frame-by-frame study of 49 Ansphare entries (catalog and keyframes are in the session scratchpad, `design/ansphare-study.md`) and after reading impeccable, frontend-design, frontend-ui-engineering, make-interfaces-feel-better (and all four of its references), better-ui, interface-design, minimalist-ui, gpt-taste, bencium-innovative-ux-designer, web-design-guidelines, rams, 12-principles-of-animation, interaction-design, awwwards-animations, design-lab, create-design-md, improve-ui, ui-skills-root, signal-geometry, threejs, improve-animations, dark-particle-explainer and ui-ux-pro-max. impeccable's `reference/*.md` files are referenced in its SKILL.md but are not on disk.

## The surface

- **Mode:** Persuade. This is a developer tool's landing page, read on X and Hacker News, often on a phone.
- **Who:** a developer who just watched an agent `npm i` something dubious. They are skeptical, they will judge the page by whether the terminal output looks real, and they will screenshot one thing.
- **Job:** make "fresh isn't safe; wait seven days" obvious in one picture, prove it with our own measured data, and hand over an install line.

## Direction: Holding Pattern

The registry behaves like an airport. Every release *arrives*, and package-guidance makes it *hold* for seven days before it is cleared to land in your lockfile. Worms are the things that arrive and leave within hours. The page is built from the instruments of that world:

1. **A release board.** This is the hero artifact: a dot-matrix arrivals board listing real verdicts from `package-guidance check` (2026-11-16). `next 16.4.6 · 6d · HOLD`, `next 16.4.5 · 12d · CLEARED`, `reqeusts-pro · NOT FOUND`. Each row carries a tiny age bar on a 0–14 day scale with the 7-day line. It is the screenshot.
2. **The release-age ruler.** This is the signature interaction: a dense tick ruler from publish to ten days. The chalk/debug compromise (≈2 h, Wiz) is a red sliver at the left edge. The 7-day cooldown is an orange window. The **39 fresh versions the plain agent actually installed** in our eval (real ages, 15 h to 6.99 d) sit as dots inside that window. With package-guidance, that row is empty. A native range input lets you drag "install at" along the ruler and tells you what you would have gotten.
3. **Operational cards.** The 7 steps and the eval run list are written as a pipeline (step, status, verdict chips) and say "running" honestly for evals that are not finished.

Why it fits the product:

- **registry:** the board's columns are what the registry knows (version, publish age, status).
- **time:** every chart's x-axis is release age.
- **cooldown:** the one accent color *is* the cooldown.
- **worms:** red appears only for the compromise window and blocked verdicts.
- **settled:** green appears only for CLEARED / ✓.

## Tokens

| Token | Light | Dark | Role |
|---|---|---|---|
| `--tarmac` | `#EEF0F2` | `#090C14` | Page ground. Cool runway grey, not cream and not pure black |
| `--apron` | `#F8F9FA` | `#10141F` | Raised surfaces (cards, tabs) |
| `--ink` | `#0D111C` | `#E9ECF3` | Primary text (≥ 15:1) |
| `--ink-2` | `#434A59` | `#AEB5C4` | Secondary text (≥ 7:1) |
| `--ink-3` | `#5B6273` | `#8B93A6` | Meta text (≥ 4.5:1) |
| `--rule` | `rgb(13 17 28 / .12)` | `rgb(233 236 243 / .11)` | Hairlines that measure |
| `--hold` | `#B83C08` text / `#F26A1B` fill | `#FF8B42` | **The one accent: hold / cooldown** |
| `--cleared` | `#127441` | `#5ED39B` | Semantic only, always beside ✓ or CLEARED |
| `--worm` | `#B91C2B` | `#FF7B82` | Semantic only, always beside ✗ or a named compromise |
| `--board` / `--board-ink` | `#0B0E17` / `#E7EAF2` | `#0E1220` / `#E7EAF2` | The board and terminals stay dark in both themes, like real hardware |

Color budget: about 85% tarmac and ink, 10% board, and under 5% hold, cleared and worm. Green and red never carry meaning alone, because a glyph or word always sits beside them.

**Type.**

- **Funnel Display** (600) is for headings. It is a grotesk with slightly flared terminals, unusual without being a novelty.
- **Funnel Sans** (400/500) is for body.
- **Doto** (700/900), a dot-matrix face, is for the board and the hero figures. Numbers drawn from dots, as on an arrivals board.
- **JetBrains Mono** (400/500) is for every command and every line of CLI output. A second `&text=` request pulls in its own ✓ ✗ → glyphs so CLI columns stay aligned.
- **Scale:** ~1.25 from a 17px body: 13.6 · 15 · 17 · 21 · 26.5 · 33 · 41, plus a display size of `clamp(2.75rem, 6vw, 5.75rem)`.
- **Text rules:** headings use `text-wrap: balance` and −0.03em tracking, body uses `text-wrap: pretty` with a 62ch measure, and dynamic numbers use `tabular-nums`.

**Space.** The base unit is 8px. Groups are tight (8/16) and chapters are wide (112–160). The column is 1200px on a 12-column grid, with 16px gutters at 375px.

**Shape and depth.** Radius is 8 on controls, 14 on cards and terminals (14 = 8 + 6 inset), and 999 only for status lamps. Depth comes from rings: shadow-as-border rings `0 0 0 1px` in both themes, with one soft lift only under the board. Hairline rules stay as dividers.

## Motion rules

- **The one orchestrated moment** is the board resolving its rows on load, a dot-matrix scramble per cell with a 40ms stagger and under 1s in total. The HOLD lamps then breathe slowly (opacity 2.4s), because *waiting* is the state they show.
- **Terminals** type once when scrolled into view. They are skippable (button, or any key inside) and replayable. The full transcript is in the HTML, so screen readers and no-JS readers get all of it.
- **The ruler** never animates itself. It moves only under the user's hand.
- **No scroll-triggered fade-ups.** No parallax, no GSAP and no WebGL; nothing here earns them. JS is vanilla and under 15 KB.
- **Interaction timing:** feedback stays under 200ms: color 150ms, press `scale(0.96)`, and copy confirmation is an icon cross-fade (scale 0.25→1, blur 4px→0, `cubic-bezier(0.2,0,0,1)`). Only named properties transition.
- **Reduced motion:** `prefers-reduced-motion: reduce` gives the final state of everything immediately, with no lamp breathing and no typing.
- **Theme switch:** transitions are suppressed for one frame.

## Borrowed from the Ansphare study (patterns, not designs)

1. A tick ruler with a single colored window, from the time-zone instrument card. Here it is the 7-day cooldown.
2. One accent with one meaning, from the time-zone card, the Quartr posters and glyphblue.
3. Operational pipeline cards with every state shown, from the deploy, sandbox and agent-plan cards. Here they carry the procedure and the eval runs ("running").
4. Dot-matrix numerals, from the braille loader, the airport matrix and the pixel loaders. Here they set the board and the figures.
5. Countable day cells and dot grids, from the contribution graph. Here they carry 27.76 of 100 lit, the 39 dots and the 7-cell week mark.
6. Character fields as texture, from the ASCII and glyph cards. Here it is a faint CSS dot field behind the hero, with no images.
7. Output as a printed artifact, from the receipt and boarding-pass printers. The terminal output is set character-for-character.
8. A quiet two-column FAQ, from infinite-faq.
9. Auditable meters with exact counts, from the usage meter. Here they carry the eval rows.
10. One physical moment, from the badge and lamp entries. Here it is the board flip plus a draggable ruler, and nothing else moves.

## Honesty rules

- Every number links to its source. Eval numbers come from `evals/results/eval-sonnet/summary.json` and the 39 dot ages come from the per-run `score.json` files (`ageDaysAtRun`, deps the agent added or changed).
- The Shai-Hulud "≈12 h" window is unverified, so it is not plotted. Shai-Hulud 2.0 is mentioned only as an event, with its Wiz link.
- We say hallucinated packages were 0 in **both** arms and claim nothing there.
- Opus, Kimi and GLM appear as "running" with no numbers.
- "agent ›" lines in the terminals are narration. Every `$` command and its output is a real capture (2026-11-16); the unguided npm run used `--ignore-scripts`.

## Brand

The mark is a lowercase **p** drawn as one line. Its bowl is the holding pattern (orange, because orange means hold) and its stem drops into a solid ink **pin**, the settled version in the lockfile. The full spec is in [`brand/BRAND.md`](../brand/BRAND.md).

- **Nav:** an inline SVG (`.brand-mark`) beside the wordmark in Funnel Display 600 at 18px. The mark is as tall as the wordmark's ascender-to-descender span. The loop uses `--mark` (`#F26A1B`, constant in both themes) and the pin uses `currentColor`.
- **Favicon:** `favicon.svg` is redrawn on a 16-unit grid so the 2px stroke lands on whole pixels. The pin switches to light ink in dark mode.
- **Semantics hold:** the logo uses only orange and ink. Green and red stay verdict colours and never appear in brand marks.
