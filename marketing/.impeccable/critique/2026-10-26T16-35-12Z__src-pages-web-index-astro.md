---
target: justrunjs editor (/web/)
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro"
target_fingerprint: "sha256:d694d3bee40d9608aac5d2a4f8309e358a1a362697650a803a434221cf4413a4"
target_path: /Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro
timestamp: 2026-10-26T16-35-12Z
slug: src-pages-web-index-astro
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

## Design Health Score: 25/40 (Acceptable), up from 24

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Save status truthful; status dot colour-only; save status hidden on phone |
| 2 | Match system / real world | 2 | Raw engine errors; "experiment" / "my copy" / "@ 0:12" name one thing |
| 3 | User control and freedom | 3 | Fork / Back / Open your experiment work; fork keeps instructor's half-typed token |
| 4 | Consistency and standards | 2 | Two fork naming styles; lesson and example both "Array basics" |
| 5 | Error prevention | 2 | TS/JS badge silently converts a tab; Account popover focuses Sign out |
| 6 | Recognition over recall | 2 | Icon-only rail; shortcuts only in a tooltip |
| 7 | Flexibility and efficiency | 3 | Cmd+Enter, Space, arrows, speed, + menu |
| 8 | Aesthetic and minimalist | 3 | Restrained; + menu renders 935px tall (cascade bug) |
| 9 | Error recovery | 2 | Runtime errors keep values now; nothing in the gutter; syntax error clears values |
| 10 | Help and documentation | 2 | Only the lesson intro; no empty state or shortcut list |

## Design specificity verdict
Mostly specific: replay in the real editor, fork/return, truthful save wording. Generic: icon rail and a lesson bar that looks like a stock media player. Values in a pane ~400px away undercut "next to its line".

Detector: 0 findings on all live URLs at 1280 and 390. Overlay (greeting-card, after code ran): 1 real low-contrast — playground inline values `.cm-inline-value` 3.9:1 (muted text at opacity 0.85, style.css:714-717). Source: overused-font (Geist), deliberate.

## Fixed since run 2
Runtime errors keep earlier values and sit on the throwing line; no error flashes during playback (verified by polling); truthful save status with reason/Retry/back-off; dev proxy 403.

## Priority issues
- [P1] Paused, resumed and forked lesson states land on the instructor's half-typed code and show red errors; forks inherit the broken token. Snap resume/pause/fork to the last state that parses. → harden
- [P1] Values aren't beside their lines on screen: aligned by height but in a pane ~400px away (below on phone). Show values inline at line ends (as the playground does), errors in the gutter. → layout
- [P2] Engine-jargon errors; a syntax error clears all values. Keep last good values above it; plain sentence. → clarify
- [P2] + New tab menu 935px tall: `.new-tab-menu` media rule (style.css:536) precedes `.settings-popover` (541). Also playground inline values 3.9:1. → polish
- [P2] End card weak; lesson index has no done marks; duplicate "Array basics". → delight, onboard

## Persona red flags
- Beginner: red errors on the teacher's paused code; two "play" ideas (Run vs lesson Play); silent TS/JS toggle; author setting visible.
- Developer: declarations show no value; runtime error doesn't say later lines didn't run; no shortcut list.
- Phone: save status hidden; ~4 editor lines; lesson bar wraps.

## Minor
Account popover focuses Sign out; theme swatches low contrast; resume toast overlaps tab bar; resume toast vs "Press Play to start".

## Questions
- Should pause snap to teaching moments rather than mid-keystroke states?
- Should the end of a lesson say "now it's yours" rather than offer Replay equally?
- What makes a side pane feel like part of the code?
