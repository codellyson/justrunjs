---
target: landing page (marketing/src/pages/index.astro)
total_score: 16
max_score: 32
na_heuristics: 7,10
p0_count: 1
p1_count: 2
target_identity: "file:/Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/index.astro"
target_fingerprint: "sha256:934b6d258e6340796da2f26a5d01885da1e891db48de7d264e0f528db1632453"
target_path: /Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/index.astro
timestamp: 2026-10-26T18-57-10Z
slug: src-pages-index-astro
---
# Critique: landing page (src/pages/index.astro), Persuade mode. Method: dual-agent

Detector: 0 findings (index.astro, Layout.astro, EditorEmbed.astro, live URL default + 390x844, overlay).

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | System status | 2 | Nothing says what the hero button does |
| 2 | Match real world | 2 | "Open in browser" while in a browser; jargon (top-level expression, tsconfig) |
| 3 | User control | 1 | Esc cannot collapse full screen from inside the iframe; Back does not collapse |
| 4 | Consistency | 2 | "Examples & lessons" / "Lessons" / absent from the page |
| 5 | Error prevention | 3 | Low risk |
| 6 | Recognition | 2 | Lessons behind an unlabelled rail icon |
| 7 | Flexibility | n/a | |
| 8 | Minimalist | 3 | Calm, close to too bare |
| 9 | Error recovery | 1 | Embed shows last saved tab, can render no inline value |
| 10 | Help | n/a | |
| | Total | 16/32 | Acceptable |

Specificity: half. Live editor under the hero is product-specific; the rest is a stock dev-tool template.

## Priority issues
1. [P0] Teaching half missing from the page and its meta/JSON-LD; breaks PRODUCT.md "served equally". Fix: lesson door linking ?lesson=array-basics, update meta. clarify then shape.
2. [P1] "Press Esc to collapse" is false: the parent keydown listener cannot hear keys in the iframe. Fix: the embedded iframe posts {type:"collapse"} on Esc; push history on expand; drop the Esc caption on phone. harden.
3. [P1] Embed shares localStorage with /web/, so it may show a tab with no inline value. Fix: embed mode always opens a demo/STARTER tab. onboard.
4. [P2] Hero button "Open in browser" mislabelled (it scrolls and expands). Fix: "Try it here" + "Take a lesson". clarify.
5. [P2] 1-2-3 steps and FAQ are developer-only template filler. Fix: show pause-edit-return or a value appearing. bolder.

## Persona red flags
- Student: jargon; account need unstated; lesson invite gone after "Not now".
- Comparing developer: no inline-value proof above the fold; footer lacks app link.
- Phone: maximum-scale=1 blocks pinch-zoom (WCAG 1.4.4); Esc caption; 540px card scroll trap.

## Minor
Root 13px font-size makes small muted text 12px; dead code (launchUrl, hidden demo section, /app comments); JSON-LD falls back to runjs-rs.pages.dev; embed may show the signed-in email publicly.

Not tested: fresh first visit, lesson audio, light theme, touch scrolling.
