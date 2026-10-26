# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, served equally:

- **People writing JavaScript who want instant feedback.** They open crow to try an idea in TypeScript or JavaScript and see every top-level value beside its line, or to build a small HTML/CSS/JS page with a live preview. No install, no project setup.
- **Students learning to code from the owner's recorded lessons.** Levels are mixed: complete beginners, people who know a little, and working developers learning a specific technique. They mostly watch and practise on a laptop, and sometimes use a phone to watch a lesson or review their work.

The owner is also a user: the one person who records and publishes lessons.

## Product Purpose

crow is a browser scratchpad and playground that doubles as the owner's teaching platform. A lesson is narration plus every code change, replayed in the real editor: students can pause at any moment, edit the code, run their own version, and return to the instructor's exact state without losing their work. Success is a student following a lesson, experimenting, and coming back, and a developer getting an answer to "what does this evaluate to?" in seconds.

It is built for the owner to teach with, not as a commercial course marketplace.

## Positioning

The lesson is not a video of an editor; it is the editor. Recorded edits replay into a live, runnable workspace, so a student's experiment is a real tab they can keep, and the scratchpad shows each line's value inline while the lesson types. A screen recording or a static code sandbox cannot offer pause-edit-return on the instructor's own code.

## Operating Context

- **Scratchpad tabs:** TS/JS run in a Web Worker; each top-level expression's value appears beside its line. `npm:` imports load as ESM from esm.sh.
- **Playground tabs:** HTML, CSS and JS panels render in a sandboxed iframe with a console.
- **Recording:** the owner records a tab with their microphone; every edit, panel switch and run is logged against the audio clock, then saved as lesson JSON plus audio into `public/lessons/` and listed in `src/learn/course.json`.
- **Course page:** `/learn/` lists the lessons in `src/learn/course.json` (course name, intro, teacher, order) with each student's progress and copies.
- **Playback:** `/learn/<name>` is the lesson page; audio drives a read-only editor that replays the instructor's changes, runs the code and shows values. Old `/web/?lesson=<name>` links redirect there. Clicking the code pauses the lesson and opens the student's own copy from that moment ("Your turn"); copies, progress and finished lessons are kept in the browser.
- **Accounts:** optional email-code sign-in, on the course page or in the scratchpad. Signed in, a student's lesson copies, finished lessons and lesson positions sync across devices (when two devices change the same copy, both versions are kept); guests keep everything in their browser. Experiments made with the old in-editor player still sync from the scratchpad.
- **Landing page:** developers first (the scratchpad), lessons second. Its hero is a real lesson playing muted and looping (`/learn/<name>?demo`), and its other pictures are screenshots captured from the running app; no drawn or invented UI. With no teacher photo in `course.json`, no stand-in avatar is shown anywhere.

## Capabilities and Constraints

- Browser only. The desktop (Tauri) app was removed; there is no plan to maintain one.
- Hosted as one Cloudflare Worker (static assets plus API) with a D1 database.
- Lessons cover static web projects and scratchpad JS/TS; no backend servers or package installs inside lessons.
- One lesson author (the owner). No creator accounts, review workflow, marketplace, or payments.
- Laptop is the primary practice device; lessons must still be watchable and reviewable on a phone.
- Undecided: a course/lesson index page for students; lesson discovery beyond direct links.

## Brand Commitments

- Name: **crow** (lowercase), after a bird that learns by watching others, the way students learn from a lesson. Renamed from justrunjs on 2026-10-26; the domain, repository, folders and saved-data keys still say justrunjs/runjs.
- One look everywhere, the classroom's: personal, immersive and warm. A warm dark stage, the Recursive typeface (casual mono for code), apricot for the teacher and actions, teal for values and the student's work. Lessons (`/learn/`) always use it.
- Built on the owner's design system `@codellyson/justui` (tokens, boot script, theme picker). The look ships as the "Classroom" theme (`src/lib/classroom-theme.ts`), the default on its dark stage for the landing page and scratchpad; justui's other themes stay available in the picker.

## Evidence on Hand

- Two demo lessons in `public/lessons/` (`greeting-card`, a playground lesson; `array-basics`, a scratchpad lesson). Their narration is synthetic text-to-speech placeholders, not the owner's voice.
- Built-in examples in `src/web/examples.ts`.
- No real students, testimonials, usage numbers or press yet. Do not invent any.

## Product Principles

1. **The editor is the lesson.** Anything a student sees in a lesson is real, runnable code they can touch.
2. **Experiments never cost the lesson.** Editing forks the student's own copy; the instructor's version and the student's work are both always recoverable.
3. **Instant feedback over ceremony.** No setup, no install, values and output appear as you type.
4. **Say where work is saved.** "On this device" and "in your account" are different promises and are always shown truthfully.
5. **Serve beginners without slowing experts.** Mixed-level audience: clear defaults, nothing that gets in a fluent developer's way.

## Accessibility & Inclusion

- WCAG 2.2 AA is the target: text contrast at least 4.5:1 in every theme (justui ≥1.0.3 guarantees its text tokens), full keyboard operation of the editor chrome, and captions/transcripts for narrated lessons when real lessons ship.
- Mixed-level learners: plain language in the interface, no jargon where a plain word works.
