# package-guidance brand

## The mark: Holding Pattern

The mark is a lowercase **p** drawn as a single line. Its bowl is a **holding pattern**, the racetrack loop that aircraft fly while they wait for clearance to land. Its stem is the descent, and the solid dot at the foot is the **pin**: the settled version that lands in your lockfile.

So the logo makes the product's whole claim: a fresh release circles for seven days, then it is cleared to land. It also reads as a plain "p" for *package*, which helps it hold up at 16px.

Why this one won (the exploration is in the session scratchpad, `design/brand-research/marks/contact-sheet-1.png` and `-2.png`):

- **It is one gesture.** One stroke and one dot. The loop is orange because orange means *hold*. The dot is ink because a pinned version has stopped moving.
- **It survives 16px.** The bowl, the counter and the dot are still separate at 16px, light or dark. The seven-dot loop, the dial, the stamp and the dot-matrix "7" all failed this test.
- **It is not a generic symbol.** It is not a shield, padlock, box, sparkle or clock. The cooldown dial read as a progress spinner. The bare racetrack read as a toggle switch.
- **It grows out of the site.** The site already uses Holding Pattern, the one orange that means hold, and the dark board. The mark is that metaphor drawn as a letter.

## Construction

Master grid: 32 × 32 units (`mark.svg`).

| Part | Geometry |
|---|---|
| Stroke | 4 units, butt ends, one path: `M8 24V10 a5 5 0 0 1 5-5 h9 a5 5 0 0 1 0 10 h-9 a5 5 0 0 1-5-5` |
| Loop (bowl) | stadium, centreline 19 × 10, radius 5; outer box 23 × 14, a 1.64 : 1 racetrack |
| Stem | x = 8, from the loop's midline down into the pin |
| Pin | circle, centre (8, 24.5), r = 4.75 (2.4 × the stroke) |
| Bounding box | x 3.25–29, y 3–29.25 (25.75 × 26.25) |

- **16px version** (`site/favicon.svg`): this is redrawn on a 16-unit grid with a 2px stroke on whole pixels (stem x = 4, loop rows 2–4 and 7–9) and r = 2.4. Use it for anything that renders at 24px or smaller. In the favicon the pin switches to light ink when the system is in dark mode.
- **Lockup:** the mark's height equals the wordmark's ascender-to-descender span (the top of *d/k* to the bottom of *p/g*). The gap between them is 0.42 × the font size.
- **Optical centring in tiles** (avatar, plugin icon): the pin pulls the eye down and to the left, so the mark is nudged about 1.5% right and 1.5% up from the centre of its bounding box.
- **Clearspace:** at least one pin diameter (9.5 units, about 0.36 × the mark's height) on every side. For the lockup, use the pin diameter at lockup scale.
- **Minimum size:** 16px for the mark (use the 16-grid file below 24px). For the lockup, 14px for the wordmark's cap-to-descender height, which is about 18px of type. Below that, use the mark alone.

## Files

| File | Use |
|---|---|
| `mark.svg` | Colour mark: orange loop, ink pin (`#0D111C`). For light grounds |
| `mark-mono.svg` | Single colour, `currentColor`. For one-colour print, stamps and CLI docs |
| `lockup-light.svg` / `lockup-dark.svg` | Mark and wordmark with the type outlined (Funnel Display 600) |
| `avatar-400.png` | X and GitHub avatar, safe inside a circle crop |
| `x-banner-1500x500.png` | X header. The text keeps clear of the bottom-left avatar overlap |
| `social-preview-1280x640.png` | GitHub repository social card |
| `readme-banner-light.svg` / `readme-banner-dark.svg` | README header, switched with `<picture>` |
| `../site/favicon.svg`, `../site/og.png`, `../.claude-plugin/icon.png` | Applied uses |

## Colour

The mark uses **one constant orange** in both themes so it is recognisable everywhere. Interface text keeps the site's darker `--hold` for contrast.

| Token | Value | Role |
|---|---|---|
| `--mark` / hold orange | `#F26A1B` | The loop. Hold and cooldown. The only brand colour |
| `--hold` (text, light) | `#B83C08` | Orange text on light grounds (≥ 4.5 : 1) |
| `--hold` (dark) | `#FF8B42` | Orange text and lamps on the board |
| ink | `#0D111C` / dark `#E9ECF3` | The pin, the wordmark, body text |
| board | `#0B0E17`, ink `#E7EAF2`, dim `#8D96AA` | Avatar, icon, banners and terminals. The board stays dark in both themes |
| tarmac | `#EEF0F2` / dark `#090C14` | Page ground |
| cleared | `#127441` / dark `#5ED39B` | Semantic only, always next to ✓ or the word CLEARED. Never in the logo |
| worm | `#B91C2B` / dark `#FF7B82` | Semantic only, always next to ✗ or a named compromise. Never in the logo |

Budget: the brand is mostly ink, tarmac and board. Orange covers less than 5% of a layout, and green and red appear only when they carry a verdict.

## Typography

All three faces are on Google Fonts under the SIL Open Font License. Outlining glyphs into a logo is allowed under the OFL.

- **Funnel Display 600** for the wordmark (lowercase, hyphen kept, −0.03em tracking) and headlines (−0.035 to −0.042em).
- **Funnel Sans 400/500** for body copy.
- **Doto 900, ROND 100** for board labels, versions, verdicts and the "wait 7d." sign-off. It is never used for sentences.
- **JetBrains Mono 400/500** for every command and every line of CLI output.

The name is always `package-guidance`: lowercase, one hyphen, never title-cased and never shortened to "PG" in public.

## Motion

**A release enters the loop and laps it, the bowl lighting one of its seven segments per lap (one lap per day), then drops down the stem and settles into the pin. The whole move takes about 1.6s on an ease-out, and the pin lands without a bounce, because settled things don't bounce.**

At rest the mark never moves. In UI, only the board's HOLD lamps breathe.

## Voice and tone

Plain, specific and a little dry. We speak like the CLI: say what happened, say what to do instead, and show the evidence.

| Do | Don't |
|---|---|
| "16.4.6 was published 6d ago; holding at 16.4.5 until it settles." | "Our AI-powered engine keeps you safe from threats!" |
| "Likely hallucinated: not on the npm registry." | "Oops! We couldn't find that package 😅" |
| "Agents install fresh versions within hours of release. So do worms." | "Revolutionary next-gen supply-chain protection." |
| "Stop your coding agent from installing 2023." | "Unleash secure, seamless dependency management." |

- Every number links to its source (README.md or `evals/published/`). If we didn't measure it, we don't say it.
- Show real CLI output, dated, rather than a paraphrase.
- Use worms and compromises as named events, not fear. Name the incident and link it.

## Do and don't

**Do**

- Put the mark on tarmac, apron or board grounds.
- Keep the loop orange and the pin ink (or board ink on dark).
- Use `mark-mono.svg` when you only have one colour.
- Use the segmented loop (seven gaps in the bowl) only in large diagram art: banners, the social card, the launch video.

**Don't**

- Put the mark in a shield, padlock, box or speech bubble, or add sparkles, gradients, glows or a drop shadow.
- Recolour the loop green or red. Those colours are verdicts, not brand.
- Rotate or mirror the mark, or close the stem into a "b" or "d".
- Turn the stem into a "P" (no capital). Separate the pin from the stem.
- Set the wordmark in another face, track it out, or write it as "Package Guidance".
- Use the 32-grid master below 24px. Use the 16-grid favicon geometry instead.
