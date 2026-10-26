# crow

A JavaScript scratchpad with inline values, and narrated lessons that replay in a live editor. (Formerly justrunjs; the repository keeps that name.)

A browser JavaScript/TypeScript scratchpad with inline values, an HTML/CSS/JS
playground with live preview, and recorded lessons you can pause and edit.

Everything lives in [`marketing/`](./marketing): an Astro site whose `/web/` page
is the editor.

- **Scratchpad tabs** run code in a Web Worker (`src/web/worker.ts`); Babel strips
  types and instruments each top-level expression so its value shows beside the line.
- **Playground tabs** render HTML/CSS/JS in a sandboxed iframe with a console bridge.
- **Lessons** (`src/web/lesson.ts`, `src/web/lesson-mode.ts`) record narration plus
  every editor change, and play back from `public/lessons/<name>.json` at
  `/web/?lesson=<name>`. A learner's first edit forks an ordinary tab.
- **Accounts** (`worker/index.ts`, `src/web/account.ts`): email-code sign-in; a learner's
  experiments and lesson progress sync to D1 so they follow them across devices.

## Develop

```sh
pnpm install
pnpm dev                       # astro dev
pnpm --filter runjs-rs-marketing test
pnpm build                     # writes marketing/dist
```

Deployment: see [DEPLOYMENT.md](./DEPLOYMENT.md). Playground design notes:
[PLAYGROUND.md](./PLAYGROUND.md). Design system: [STYLE_GUIDE.md](./STYLE_GUIDE.md).
