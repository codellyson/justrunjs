---
target: justrunjs editor (/web/)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro"
target_fingerprint: "sha256:a38d87011ff6e1cc001cacc3d0b48434ceab9e7c90cd2521884a0f9eb94d6f2c"
target_path: /Users/lukmanisiaka/Desktop/workfolder/personal-projects/justrunjs/marketing/src/pages/web/index.astro
timestamp: 2026-10-26T16-10-04Z
slug: src-pages-web-index-astro
---
Method: dual-agent (A: design review sub-agent · B: detector + browser sub-agent)

## Design Health Score: 24/40 (Acceptable) — same total as run 1, different (deeper) problems

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | "Not saved to your account yet" with no reason or Retry; scratch tabs never say where they're saved |
| 2 | Match system / real world | 3 | Plain lesson copy; "Auto-evaluate on type", "Inline values in playground" are jargon |
| 3 | User control and freedom | 3 | Fork → Back to lesson → Open your experiment is lossless |
| 4 | Consistency and standards | 2 | "Array basics" listed twice; 0:26 in list vs 0:25 in player; end-card emphasis reversed |
| 5 | Error prevention | 2 | Learners see red errors while the instructor is mid-keystroke |
| 6 | Recognition over recall | 2 | Icon-only rail, worse on the phone bottom bar; file tabs lack accessible names |
| 7 | Flexibility and efficiency | 3 | Cmd+Enter, Space, arrows; 5s seek coarse for short lessons; no shortcut sheet |
| 8 | Aesthetic and minimalist | 3 | Calm; + menu panel ~460px tall for 4 items |
| 9 | Error recovery | 1 | A runtime error wipes every value and sits at line 1 |
| 10 | Help and documentation | 1 | No explanation of experiments, no shortcut help |

## Design specificity verdict
Mostly authored now: the in-editor lesson bar, intro, captions, fork → "my copy from 0:16" → Back to lesson → Open your experiment, the resume toast, and line-numbered values are specific to justrunjs. Still generic: the unlabelled icon rail, monospace-everywhere chrome, and an end card that reads like a media player.

Detector: 0 findings on all three live pages at 1280 and 390 wide; overlay on array-basics clean. Source scan: 2 overused-font (Geist @font-face), a deliberate match with the marketing site.

## Fixed since run 1
Editor collapse (P0), values beside their lines, lesson frame (intro/captions/end card/link to experiment), Record hidden from students, + menu and tab overflow cue, experiment naming, toast position, comment contrast, keyboard lesson control.
Also fixed during this run: the dev proxy kept the dev server's Host, so the Worker refused every save made through `pnpm dev` with 403 (production unaffected).

## Priority issues
- [P1] Runtime errors erase all values and anchor at line 1 (`foo.bar` on line 7 → "1 error: foo is not defined", values on lines 2/4/6 gone). Keep values before the throw; place the error at the throwing statement. → harden
- [P1] Learners see red errors while the instructor is typing (char-by-char replay is briefly invalid code). During playback, hold the last good values/preview and hide syntax errors until the recorded edit settles. → harden, clarify
- [P1] Save status has no recovery: a failed save shows "Not saved to your account yet" with no reason or Retry, failed saves retry on every edit with no backoff (36 PUTs observed), and scratch tabs never show where they're saved. → clarify, harden
- [P2] End card: Replay is the bordered (primary-looking) button while Start experimenting/Open your experiment is plain; no next lesson or progress. → delight, onboard
- [P2] Unlabelled icon rail (worst on the phone bottom bar); file tabs announced without names; status dot aria-hidden. → adapt, audit

## Persona red flags
- Beginner: lessons only behind an unlabelled book icon; red errors mid-lesson; "Array basics" twice; resumed lesson still says "Press Play to start".
- Developer: runtime error erases everything; values ~350px from code; no shortcut sheet.
- Phone: playground lesson leaves ~6 visible code lines; unlabelled bottom bar.

## Minor observations
Lesson durations rounded vs floored (0:26 vs 0:25); + menu oversized; author-only setting visible to students; faint italic placeholder.

## Questions to consider
- Should an experiment open beside the lesson (split) rather than replace it in the tab strip?
- Should the end of a lesson say "your turn" instead of "Replay"?
- When an error can't be placed, say "somewhere after line 6" rather than line 1?
