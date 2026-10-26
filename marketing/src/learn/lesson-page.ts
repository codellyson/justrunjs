// The lesson page: narration audio drives a read-only editor that replays every change the
// instructor made, runs the code as it goes, and shows each value beside its line.
import { ChangeSet, Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, lineNumbers, type DecorationSet } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { checkpoints, completeAt, formatTime, seek, step, type Lesson, type ReplayState, type SlotId } from "../web/lesson.ts";
import { inlineValuesField, setInlineValues } from "../web/inline-values.ts";
import { createScratchRunner } from "../web/scratch-runner.ts";
import { createPreview } from "../web/preview.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.definitionKeyword, tags.operator], color: "#e8a6c8" },
  { tag: [tags.string, tags.special(tags.string)], color: "#c9d98a" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#f0c27a" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.typeName, tags.className], color: "#8fc3f0" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "#a39585", fontStyle: "italic" },
  { tag: [tags.tagName, tags.angleBracket], color: "#e8a6c8" },
  { tag: [tags.attributeName, tags.propertyName], color: "#8fc3f0" },
  { tag: tags.attributeValue, color: "#c9d98a" },
  { tag: [tags.punctuation, tags.bracket], color: "#d6cbbd" },
]);

// The instructor's caret, drawn by the page: the editor itself is read-only and never focused.
class CaretWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return Object.assign(document.createElement("span"), { className: "lp-caret" });
  }
}
const setCaret = StateEffect.define<number | null>();
const caretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setCaret)) continue;
      if (e.value === null) deco = Decoration.none;
      else {
        const pos = Math.min(e.value, tr.state.doc.length);
        deco = Decoration.set([
          Decoration.line({ class: "lp-typing" }).range(tr.state.doc.lineAt(pos).from),
          Decoration.widget({ widget: new CaretWidget(), side: 1 }).range(pos),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// A replayed keystroke briefly breaks the code. While the lesson plays, an error only shows if
// the code is still broken this long after the last edit; until then the last good values stay.
const SETTLE_MS = 1200;
const INTRO = "Press play to start the lesson.";

export async function startLesson(slug: string) {
  const root = $("lp");
  const caption = $("lp-caption");
  const playBtn = $<HTMLButtonElement>("lp-play");
  const timeEl = $("lp-time");
  const seekEl = $<HTMLInputElement>("lp-seek");
  const segmentsEl = $("lp-segments");
  const speedEl = $<HTMLSelectElement>("lp-speed");
  const ccBtn = $<HTMLButtonElement>("lp-cc");
  const filesEl = $("lp-files");

  const audio = new Audio();
  let lesson: Lesson;
  let marks: ReplayState[];
  let s: ReplayState;
  let shownMs = 0;
  let started = false;
  let ended = false;
  let lastEditAt = 0;
  let editorSlot: SlotId = "main";
  let parse: ((src: string) => unknown) | null = null;

  const language = new Compartment();
  const view = new EditorView({
    parent: $("lp-editor"),
    state: EditorState.create({
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        language.of([]),
        syntaxHighlighting(highlight),
        inlineValuesField,
        caretField,
        EditorView.theme({ "&": { backgroundColor: "transparent" } }, { dark: true }),
      ],
    }),
  });

  const playing = () => !audio.paused && !ended;
  const shownSlot = (): SlotId => (lesson.kind === "playground" ? s.active : "main");
  const docOf = (id: SlotId) => s.docs.get(id)?.toString() ?? "";

  // ---------- running the code ----------

  let runTimer: ReturnType<typeof setTimeout> | undefined;
  function holdError(): boolean {
    const since = performance.now() - lastEditAt;
    if (!playing() || since >= SETTLE_MS) return false;
    runSoon(SETTLE_MS - since + 50);
    return true;
  }

  const runner = createScratchRunner({
    source: () => view.state.doc.toString(),
    onChange: () => {
      if (editorSlot === "main") view.dispatch({ effects: setInlineValues.of(runner.inlineValues()) });
    },
    onStatus: () => {},
    holdError,
  });

  // Playground values, by line of the JS file; shown while the JS file is on screen.
  const jsValues = new Map<number, string>();
  const showJsValues = () => {
    if (editorSlot !== "js") return;
    const values = [...jsValues].filter(([, text]) => text !== "undefined").map(([line, text]) => ({ line, text }));
    view.dispatch({ effects: setInlineValues.of(values) });
  };
  const preview = createPreview($<HTMLIFrameElement>("lp-frame"), {
    onStatus: () => {},
    holdError,
    onReset() {
      jsValues.clear();
      showJsValues();
    },
    onValue(line, text) {
      jsValues.set(line, text);
      showJsValues();
    },
    onConsole: () => {},
  });

  function run() {
    if (lesson.kind === "playground") void preview.render({ html: docOf("html"), css: docOf("css"), js: docOf("js") }, true);
    else void runner.run();
  }
  function runSoon(delay = 300) {
    clearTimeout(runTimer);
    runTimer = setTimeout(run, delay);
  }

  // ---------- replay ----------

  function languageFor(slot: SlotId) {
    if (slot === "html") return html();
    if (slot === "css") return css();
    return javascript({ typescript: lesson.language === "typescript" });
  }

  /** Where the instructor's caret was: after their last edit to this file, or where they last clicked. */
  function caretTo(slot: SlotId) {
    let pos = view.state.doc.length;
    for (let i = s.next - 1; i >= 0; i--) {
      const e = lesson.events[i];
      if (e.type === "select" && e.file === slot) pos = e.head;
      else if (e.type === "change" && e.file === slot) ChangeSet.fromJSON(e.changes).iterChanges((_fa, _ta, _fb, toB) => (pos = toB));
      else continue;
      break;
    }
    view.dispatch({ effects: [setCaret.of(pos), EditorView.scrollIntoView(Math.min(pos, view.state.doc.length), { y: "nearest" })] });
  }

  /** Put the file the lesson is showing into the editor. */
  function loadSlot() {
    editorSlot = shownSlot();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: docOf(editorSlot) },
      effects: [language.reconfigure(languageFor(editorSlot)), setInlineValues.of([])],
      annotations: Transaction.addToHistory.of(false),
    });
    for (const tab of filesEl.querySelectorAll<HTMLElement>("[data-file]")) tab.classList.toggle("on", tab.dataset.file === editorSlot);
    if (editorSlot === "js") showJsValues();
    caretTo(editorSlot);
  }

  /** Show the lesson as it was at `ms`, rebuilt from the nearest checkpoint. */
  function jump(ms: number) {
    s = seek(lesson, marks, ms);
    shownMs = Math.min(ms, lesson.durationMs); // the end arrives as Infinity
    loadSlot();
    runSoon(0);
  }

  /** Apply the events between the last frame and `ms`. */
  function advance(ms: number) {
    if (ms < shownMs || ms - shownMs > 2000) return jump(ms);
    while (s.next < lesson.events.length && lesson.events[s.next].t <= ms) {
      const e = lesson.events[s.next];
      step(s, e);
      if (e.type === "open") {
        if (shownSlot() !== editorSlot) loadSlot();
      } else if (e.type === "run") runSoon(0);
      else if (e.type === "change") {
        if (e.file === editorSlot) {
          const changes = ChangeSet.fromJSON(e.changes);
          let end = 0;
          changes.iterChanges((_fa, _ta, _fb, toB) => (end = toB));
          view.dispatch({
            changes,
            effects: [setCaret.of(end), EditorView.scrollIntoView(end, { y: "nearest" })],
            annotations: Transaction.addToHistory.of(false),
          });
        }
        lastEditAt = performance.now();
        runSoon();
      } else if (e.file === editorSlot) caretTo(editorSlot);
    }
    shownMs = Math.min(ms, lesson.durationMs);
  }

  /** After a pause or a scrub, step back to the last moment the code was complete. */
  let settleGen = 0;
  async function settle(ms: number) {
    const gen = ++settleGen;
    const clean = parse ? completeAt(lesson, marks, ms, parse) : ms;
    await Promise.resolve(); // a Play click in the same task wins
    if (gen !== settleGen || clean >= ms - 1 || !audio.paused) return;
    audio.currentTime = clean / 1000;
    jump(clean);
  }

  // ---------- the player ----------

  const segments: { from: number; to: number; fill: HTMLElement }[] = [];
  function buildSegments() {
    const starts = (lesson.captions ?? []).map((c) => c.t).filter((t) => t < lesson.durationMs);
    if (!starts.length || starts[0] > 0) starts.unshift(0);
    starts.forEach((from, i) => {
      const to = starts[i + 1] ?? lesson.durationMs;
      const seg = document.createElement("span");
      seg.className = "lp-seg";
      seg.style.flexGrow = String(Math.max(1, to - from));
      const fill = document.createElement("span");
      seg.append(fill);
      segmentsEl.append(seg);
      segments.push({ from, to, fill });
    });
  }

  function captionAt(ms: number) {
    let line = "";
    for (const c of lesson.captions ?? []) {
      if (c.t > ms) break;
      line = c.text;
    }
    return line;
  }

  function paint() {
    const ms = Math.min(audio.currentTime * 1000, lesson.durationMs);
    timeEl.textContent = `${formatTime(ms)} / ${formatTime(lesson.durationMs)}`;
    if (document.activeElement !== seekEl) seekEl.value = String(ms);
    for (const seg of segments) {
      const share = Math.min(1, Math.max(0, (ms - seg.from) / (seg.to - seg.from)));
      seg.fill.style.width = `${share * 100}%`;
    }
    const line = ended ? lesson.outro ?? captionAt(ms) : started ? captionAt(ms) : INTRO;
    if (caption.textContent !== line) caption.textContent = line;
    const isPlaying = playing();
    root.classList.toggle("is-playing", isPlaying);
    playBtn.setAttribute("aria-label", isPlaying ? "Pause" : ended ? "Watch again" : "Play");
  }

  function tick() {
    if (!audio.paused) advance(audio.currentTime * 1000);
    paint();
    requestAnimationFrame(tick);
  }

  function seekTo(ms: number) {
    started = true;
    ended = false;
    audio.currentTime = ms / 1000;
    jump(ms);
    if (audio.paused) void settle(ms);
  }

  function togglePlay() {
    if (ended) seekTo(0);
    if (audio.paused) void audio.play().catch((e) => (caption.textContent = `The audio couldn't play: ${e.message}`));
    else audio.pause();
  }

  // ---------- load ----------

  caption.textContent = "Loading the lesson…";
  try {
    const res = await fetch(`/lessons/${encodeURIComponent(slug)}.json`);
    if (!res.ok) throw new Error(`This lesson couldn't be loaded (${res.status}).`);
    lesson = (await res.json()) as Lesson;
    marks = checkpoints(lesson);
    // A blob URL is always seekable, whatever Range support the host has.
    const media = await fetch(`/lessons/${lesson.audio}`);
    if (!media.ok) throw new Error(`This lesson's audio couldn't be loaded (${media.status}).`);
    audio.src = URL.createObjectURL(await media.blob());
  } catch (e) {
    caption.textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  void import("../web/transpile.ts").then((m) => (parse = m.transpile));

  if (lesson.kind === "playground") {
    filesEl.hidden = false;
    $("lp-preview").hidden = false;
    root.classList.add("is-playground");
  }
  seekEl.max = String(lesson.durationMs);
  buildSegments();
  jump(0);

  audio.onplay = () => {
    started = true;
    ended = false;
  };
  audio.onpause = () => {
    if (!ended) void settle(audio.currentTime * 1000);
  };
  audio.onended = () => {
    advance(Infinity);
    ended = true;
  };

  playBtn.disabled = false;
  playBtn.addEventListener("click", togglePlay);
  seekEl.addEventListener("input", () => seekTo(Number(seekEl.value)));
  speedEl.addEventListener("change", () => (audio.playbackRate = Number(speedEl.value)));
  ccBtn.addEventListener("click", () => {
    const on = ccBtn.getAttribute("aria-pressed") !== "true";
    ccBtn.setAttribute("aria-pressed", String(on));
    root.classList.toggle("no-captions", !on);
  });
  // Space plays or pauses and ←/→ jump 5s, unless a control that uses those keys has focus.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input, select, textarea, button")) return;
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const ms = audio.currentTime * 1000 + (e.key === "ArrowRight" ? 5000 : -5000);
      seekTo(Math.min(lesson.durationMs, Math.max(0, ms)));
    }
  });

  requestAnimationFrame(tick);
}
