---
target: justrunjs editor (/web/)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro"
target_fingerprint: "sha256:ddf4a119b07e1d1e1128502d4e9c0415da776e035046e56b8b319ff4f918fab4"
target_path: /Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro
timestamp: 2026-10-26T15-35-37Z
slug: src-pages-web-index-astro
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

## Design Health Score: 24/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | No evaluating state; status dot explains itself only on hover |
| 2 | Match system / real world | 2 | Scratchpad results numbered by sequence, not source line; "on the right" is false on phone |
| 3 | User control and freedom | 3 | Fork is safe; no route from the lesson tab back to your experiment |
| 4 | Consistency and standards | 2 | Scratchpad results pane vs playground inline values; "Examples & lessons" lists no lessons |
| 5 | Error prevention | 3 | Edits fork safely; recording guarded |
| 6 | Recognition over recall | 2 | Icon-only rail; Record and status are look-alike dots |
| 7 | Flexibility and efficiency | 3 | Cmd+Enter, Esc, quick-adds; no keyboard play/pause/seek for lessons |
| 8 | Aesthetic and minimalist | 3 | Quiet and coherent; tab strip overflows on lessons |
| 9 | Error recovery | 2 | Script errors are one truncated line with no source line; native prompt()/confirm() |
| 10 | Help and documentation | 2 | No lesson intro, captions/transcript, or end state |

## Design specificity verdict
Partly authored. The fork toast, the "Your experiment · from 0:25 / Back to lesson" bar and the truthful save status are specific to justrunjs. The chrome (icon rail, tabs, split panes) and the lesson bar (a bare media scrubber under the editor) are category-interchangeable; nothing frames a lesson as a lesson.

Detector: 1 rendered finding — code comments #7c7266 on #1e1c1a at 3.6:1 (main.ts darkHighlight comment colour), on /web/ and array-basics. 2 source findings: overused-font (Geist @font-face), a deliberate match with the marketing site. Overlay on greeting-card: no anti-patterns.

## Priority issues
- [P0, FIXED during critique] Editor collapsed to 62px on every scratchpad tab: grid auto-placement after the lesson-bar row was added. Rows now pinned.
- [P1] Scratchpad values are numbered by sequence, not anchored to their source line; copy says "beside its line" / "on the right". Fix: anchor rows to source lines or render inline like the playground; fix copy. → clarify, layout
- [P1] Lessons have no frame: no title/intro telling students they can edit, no captions/transcript, no end card, no link back to the student's experiment. → onboard, delight
- [P2] Owner and student tools share the rail: Record shows for every student; "Examples & lessons" has no lessons; icon-only buttons. → distill
- [P2] Tab strip overflow and fork naming ("Build a greeting card @ 0:25.html" pushed off-screen, quick-adds hidden, no overflow cue). → harden
- [P2] Code comments 3.6:1 in the dark editor highlight. → harden

## Persona red flags
- Beginner student: no cue that editing is allowed; reassurance toast covers Back to lesson for ~3s; results "3" beside line 1 reads as wrong; no next step at lesson end; no transcript.
- Fluent developer: sequence-numbered results slow mapping; errors lack source lines; no keyboard lesson control; settings is a 13-control sheet.
- Phone reviewer: experiment tab hidden off-screen in the strip; values are below, not "on the right".

## Minor observations
Unstyled native speed select; inconsistent lesson-bar text weights; "SIGN IN" title indented vs body; status dot looks like Record; inline-values setting exists for playground only; white preview pulls focus in dark themes.

## Questions to consider
- If the lesson is the editor, should the instructor's presence (cursor, caption, chapters) live in the code rather than a scrubber below it?
- Should scratchpad values move inline and the results pane go away on lesson tabs?
- Does a student need Record, +npm, and six themes — or does /web/ want two default states?
