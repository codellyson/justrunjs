---
target: justrunjs editor (/web/)
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro"
target_fingerprint: "sha256:335a1404e9d6188162ae813bf7b65ae654b0a2c6086f1877f4c175922a22cb5f"
target_path: /Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro
timestamp: 2026-10-26T17-05-51Z
slug: src-pages-web-index-astro
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent; B's overlay ran in the user's Chrome because the browser pane hit its tab cap)

## Design Health Score: 26/40 (Acceptable), up from 25

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Save status and fork toast good; scrub can settle mid-token in CSS |
| 2 | Match system / real world | 3 | Plain-language errors; settings jargon for beginners |
| 3 | User control and freedom | 3 | Back / Open your experiment / Replay / Esc work; Delete closes a tab |
| 4 | Consistency and standards | 2 | Legacy vs new experiment names; scratchpad shows values twice |
| 5 | Error prevention | 2 | Delete-to-close; end card opens a stale early fork |
| 6 | Recognition over recall | 2 | Icon-only rail and phone bar; shortcuts only in Settings |
| 7 | Flexibility and efficiency | 3 | ⌘↵, Space, arrows, speed, + menu |
| 8 | Aesthetic and minimalist | 3 | Calm; right pane mostly repeats inline values |
| 9 | Error recovery | 2 | console.log rows labelled line 0; syntax error after a runtime error loses values; some raw Babel text |
| 10 | Help and documentation | 2 | Intro + Keyboard section; right pane unexplained |

## Design specificity verdict
Mostly specific: inline values, pause-edit-fork with its toast and "Your experiment · from 0:11 / Back to lesson". Generic: icon rail, media-strip lesson bar, small caption at the bottom.

Detector: 0 findings on all live URLs at 1280/390; overlay clean on greeting-card (after code ran) and array-basics (inline values present). Source: overused-font (Geist), deliberate; live detector doesn't flag "Geist Variable" (detector gap).

## Priority issues
- [P1] End card "Open your experiment" opens the latest existing fork (e.g. from 0:11), not the finished state the outro asks you to change. Primary should fork from the end; older experiments secondary. → clarify
- [P1] Scratchpad output reliability: console.log captured as line 0 (worker.ts:40); last good values only recorded after an error-free run, so a syntax error following a runtime error clears values; raw Babel text ("Identifier directly after number"); unclosed `[` reports expected ","; inline error clipped at the editor edge. → harden
- [P2] Lesson hierarchy: 13px caption and small Play at the bottom; ~6 code lines on phone. → layout, typeset
- [P2] Scrub/pause settles mid-token in CSS/HTML (snap only checks the script). → polish
- [P2] Icon-only rail/bar; Delete closes a tab with one key. → harden

## Persona red flags
- Beginner: no "start here", unlabelled icons, unexplained right pane, end card leads to stale code.
- Developer: console.log line 0, values lost on a typo after a runtime error, duplicated values.
- Phone: ~6 code lines, inline error clipped, unlabelled bottom bar.

## Minor
Save-status tooltip mentions signing in while signed in; lesson bar re-render drops keyboard focus after Play/Pause; fork toast overlaps preview top; long experiment names truncate.

## Questions
- Should scratchpads drop the right pane now values are inline?
- One experiment per lesson, or one per fork?
- Should the caption be the loudest thing on screen during a lesson?
