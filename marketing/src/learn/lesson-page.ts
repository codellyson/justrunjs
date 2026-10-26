// The lesson page: narration audio drives a read-only editor that replays every change the
// instructor made, runs the code as it goes, and shows each value beside its line. Clicking the
// code pauses the lesson and opens the student's own copy of it at that moment ("Your turn").
import { Annotation, ChangeSet, Compartment, EditorState, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history as undoHistory, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { checkpoints, completeAt, formatTime, seek, step, type Lesson, type ReplayState, type SlotId } from "../web/lesson.ts";
import { inlineValuesField, setInlineValues } from "../web/inline-values.ts";
import { createScratchRunner } from "../web/scratch-runner.ts";
import { createPreview } from "../web/preview.ts";
import { findCopy, saveCopy, type LessonCopy } from "./copies.ts";
import { doneLessons, markDone, savePosition, savedPosition } from "./progress.ts";
import { pushCopy, pushProgress, signedInEmail, syncAll } from "./sync.ts";

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

/** Marks a transaction that loads a file into the editor, never an edit by the student. */
const loading = Annotation.define<boolean>();

// The student's changes to the file on screen, since their copy began: shown with a teal
// underline. Null while the lesson (not a copy) is on screen.
const setEdits = StateEffect.define<ChangeSet | null>();
const editsField = StateField.define<ChangeSet | null>({
  create: () => null,
  update(edits, tr) {
    for (const e of tr.effects) if (e.is(setEdits)) edits = e.value;
    if (edits && tr.docChanged && !tr.annotation(loading)) edits = edits.compose(tr.changes);
    return edits;
  },
});
const mineMark = Decoration.mark({ class: "lp-mine" });
const editMarks = EditorView.decorations.compute([editsField], (state) => {
  const edits = state.field(editsField);
  if (!edits) return Decoration.none;
  const ranges: ReturnType<typeof mineMark.range>[] = [];
  edits.iterChangedRanges((_fA, _tA, fromB, toB) => {
    if (toB > fromB) ranges.push(mineMark.range(fromB, toB));
  });
  return Decoration.set(ranges, true);
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
  const tryBtn = $<HTMLButtonElement>("lp-try");
  const savedEl = $("lp-saved");
  const ytText = $("lp-yt-text");
  const resetBtn = $<HTMLButtonElement>("lp-reset");
  const countEl = $("lp-count");
  const lessons = JSON.parse(root.dataset.lessons ?? "[]") as string[];

  // Signed in: bring copies and progress from the account before resuming or reopening a copy.
  // ?demo: the landing page's preview. Muted, looping, saves nothing; a click opens the real lesson.
  const demo = new URLSearchParams(location.search).has("demo");
  const synced = demo ? Promise.resolve(false) : syncAll();
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
  /** The student's copy while it's on screen; null while the lesson is. */
  let copy: LessonCopy | null = null;
  /** Whether the open copy is worth keeping: it was saved before, or the student changed it. */
  let copyKept = false;
  /** Shown instead of the intro when the lesson picks up where the student left off. */
  let resumeNote: string | null = null;

  const language = new Compartment();
  const editing = new Compartment();
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  const view = new EditorView({
    parent: $("lp-editor"),
    state: EditorState.create({
      extensions: [
        lineNumbers(),
        editing.of(readOnly),
        undoHistory(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        language.of([]),
        syntaxHighlighting(highlight),
        inlineValuesField,
        caretField,
        editsField,
        editMarks,
        EditorView.updateListener.of((u) => {
          if (!copy || !u.docChanged || u.transactions.every((t) => t.annotation(loading))) return;
          copyKept = true;
          copy.files[editorSlot] = u.state.doc.toString();
          copy.edits[editorSlot] = u.state.field(editsField)?.toJSON();
          saveSoon();
          runSoon();
        }),
        EditorView.theme({ "&": { backgroundColor: "transparent" } }, { dark: true }),
      ],
    }),
  });

  const playing = () => !audio.paused && !ended;
  const shownSlot = (): SlotId => (lesson.kind === "playground" ? s.active : "main");
  const docOf = (id: SlotId) => (copy ? copy.files[id] ?? "" : s.docs.get(id)?.toString() ?? "");

  // ---------- running the code ----------

  let runTimer: ReturnType<typeof setTimeout> | undefined;
  function holdError(): boolean {
    const since = performance.now() - lastEditAt;
    if (!playing() || since >= SETTLE_MS) return false;
    runSoon(SETTLE_MS - since + 50);
    return true;
  }

  // The line the teacher is typing right now: half-typed code (`nums.map`) has a value, but not
  // the one the lesson is heading for, so that line shows none until they move on.
  let typingLine = 0;
  const runner = createScratchRunner({
    source: () => view.state.doc.toString(),
    onChange: () => {
      if (editorSlot !== "main") return;
      const values = runner.inlineValues().filter((v) => !(playing() && v.line === typingLine && !v.error));
      view.dispatch({ effects: setInlineValues.of(values) });
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
      effects: [language.reconfigure(languageFor(editorSlot)), setInlineValues.of([]), setEdits.of(null)],
      annotations: [loading.of(true), Transaction.addToHistory.of(false)],
    });
    paintFiles();
    if (editorSlot === "js") showJsValues();
    caretTo(editorSlot);
  }

  function paintFiles() {
    for (const tab of filesEl.querySelectorAll<HTMLButtonElement>("[data-file]")) {
      tab.classList.toggle("on", tab.dataset.file === editorSlot);
      tab.setAttribute("aria-pressed", String(tab.dataset.file === editorSlot));
      tab.disabled = !copy; // during the lesson the instructor picks the file
    }
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
          typingLine = view.state.doc.lineAt(end).number;
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
    if (gen !== settleGen || clean >= ms - 1 || !audio.paused || copy) return;
    audio.currentTime = clean / 1000;
    jump(clean);
  }

  // ---------- your turn: the student's copy ----------

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function saveNow() {
    clearTimeout(saveTimer);
    if (!copy || !copyKept) return; // opening Your turn without changing anything leaves no copy behind
    if (!saveCopy(copy)) {
      savedEl.textContent = "Couldn't save on this device: your browser's storage is full or blocked";
      return;
    }
    const saving = copy;
    void pushCopy(saving).then((state) => {
      if (copy !== saving) return; // the student has moved on
      savedEl.textContent =
        state === "account" ? "Saved in your account"
        : state === "failed" ? "Saved on this device. Couldn't reach your account; it tries again on your next change."
        : "Saved on this device";
    });
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  /** Put one of the copy's files in the editor, its changes marked; `pos` places the caret (default: the end). */
  function showCopyFile(slot: SlotId, pos?: number) {
    if (!copy) return;
    editorSlot = slot;
    copy.active = slot;
    const text = copy.files[slot] ?? "";
    let edits = ChangeSet.empty(text.length);
    try {
      if (copy.edits[slot]) edits = ChangeSet.fromJSON(copy.edits[slot]);
    } catch {
      /* unreadable marks: show the text without them */
    }
    if (edits.newLength !== text.length) edits = ChangeSet.empty(text.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: Math.min(pos ?? text.length, text.length) }, // no click position: at the end
      effects: [language.reconfigure(languageFor(slot)), setInlineValues.of([]), setEdits.of(edits), setCaret.of(null)],
      annotations: [loading.of(true), Transaction.addToHistory.of(false)],
    });
    paintFiles();
    if (slot === "js") showJsValues();
  }

  /**
   * Pause the lesson at the last complete code and open the student's copy from there.
   * `origin` reopens the copy that started at that moment (from the page address).
   */
  function enterCopy(pos?: number, origin?: number) {
    if (copy) return;
    settleGen++; // a pending step-back would otherwise replace the copy with the lesson
    const at = ended ? lesson.durationMs : Math.min(audio.currentTime * 1000, lesson.durationMs);
    audio.pause();
    origin ??= Math.round(parse ? completeAt(lesson, marks, at, parse) : at);
    s = seek(lesson, marks, origin);
    shownMs = origin;
    audio.currentTime = origin / 1000;
    const existing = findCopy(slug, origin);
    copyKept = !!existing;
    copy = existing ?? {
      slug,
      originMs: origin,
      files: Object.fromEntries([...s.docs].map(([id, doc]) => [id, doc.toString()])),
      active: shownSlot(),
      edits: {},
      updatedAt: 0,
    };
    savedEl.textContent = existing ? "Saved on this device" : "Your changes save on this device";
    void signedInEmail().then((email) => {
      if (!email || !copy) return;
      savedEl.textContent = !existing ? "Your changes save to your account" : existing.synced === false ? "Saved on this device" : "Saved in your account";
    });
    const atEnd = origin >= lesson.durationMs - 250;
    ytText.textContent = atEnd
      ? "This is where we ended up. Change anything you like; my version stays exactly as it was."
      : `I've paused at ${formatTime(origin)}. Change anything you like; my version stays exactly as it was.`;
    $("lp-continue-label").textContent = atEnd ? "Watch the lesson again" : "Continue the lesson";
    root.classList.add("is-yours");
    ended = false;
    started = true;
    // The address names the copy, so a reload (or a link from the course page) comes back to it.
    history.replaceState(null, "", `?copy=${origin}`);
    view.dispatch({ effects: editing.reconfigure([]) });
    showCopyFile(lesson.kind === "playground" ? copy.active : "main", pos);
    view.focus();
    runSoon(0);
  }

  /** Back to the lesson where the copy began; the copy stays saved. */
  function leaveCopy() {
    if (!copy) return 0;
    saveNow();
    const origin = copy.originMs;
    copy = null;
    resetArmed = false;
    resetBtn.textContent = "Reset to my code";
    root.classList.remove("is-yours");
    history.replaceState(null, "", location.pathname);
    view.dispatch({ effects: editing.reconfigure(readOnly) });
    return origin;
  }

  function continueLesson() {
    const origin = leaveCopy();
    const fromStart = origin >= lesson.durationMs - 250; // a copy of the finished lesson
    seekTo(fromStart ? 0 : origin);
    void audio.play().catch((e) => (caption.textContent = `The audio couldn't play: ${e.message}`));
  }

  // Resetting throws away the student's changes, so it takes a second click to confirm.
  let resetArmed = false;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  function resetCopy() {
    if (!copy) return;
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = "Click again to lose your changes";
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        resetArmed = false;
        resetBtn.textContent = "Reset to my code";
      }, 4000);
      return;
    }
    resetArmed = false;
    resetBtn.textContent = "Reset to my code";
    const docs = seek(lesson, marks, copy.originMs).docs;
    copy.files = Object.fromEntries([...docs].map(([id, doc]) => [id, doc.toString()]));
    copy.edits = {};
    showCopyFile(copy.active);
    saveNow();
    runSoon(0);
    view.focus();
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
    const ms = copy ? copy.originMs : Math.min(audio.currentTime * 1000, lesson.durationMs);
    timeEl.textContent = `${copy ? "Paused at " : ""}${formatTime(ms)} / ${formatTime(lesson.durationMs)}`;
    if (document.activeElement !== seekEl) seekEl.value = String(ms);
    for (const seg of segments) {
      const share = Math.min(1, Math.max(0, (ms - seg.from) / (seg.to - seg.from)));
      seg.fill.style.width = `${share * 100}%`;
    }
    const line = started ? captionAt(ms) : resumeNote ?? INTRO;
    if (caption.textContent !== line) caption.textContent = line;
    const isPlaying = playing();
    root.classList.toggle("is-playing", isPlaying);
    root.classList.toggle("is-ended", ended && !copy);
    playBtn.setAttribute("aria-label", copy ? "Continue the lesson" : isPlaying ? "Pause" : ended ? "Watch again" : "Play");
  }

  // Where the student is, remembered every few seconds of playback and whenever it stops.
  let positionSavedAt = 0;
  function rememberPosition() {
    positionSavedAt = performance.now();
    if (ended || demo) return;
    savePosition(slug, audio.currentTime * 1000);
    void pushProgress(slug, audio.currentTime * 1000);
  }

  /** Done lessons in the header: teal dots, and a count once this one is finished. */
  function paintDone() {
    const done = doneLessons();
    for (const dot of document.querySelectorAll<HTMLElement>(".lp-dot")) dot.classList.toggle("done", done.includes(dot.dataset.slug ?? ""));
    const count = lessons.filter((l) => done.includes(l)).length;
    countEl.textContent = ended ? `${count} of ${lessons.length} done` : `Lesson ${lessons.indexOf(slug) + 1} of ${lessons.length}`;
  }

  function finish() {
    advance(Infinity);
    ended = true;
    markDone(slug);
    savePosition(slug, 0);
    void pushProgress(slug, 0, true);
    $("lp-end-text").textContent = lesson.outro ?? "Click into the code and change anything you like; my version stays exactly as it was.";
    paintDone();
    requestAnimationFrame(() => document.querySelector(".lp-end")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  function tick() {
    if (!audio.paused && !copy) {
      advance(audio.currentTime * 1000);
      if (performance.now() - positionSavedAt > 5000) rememberPosition();
    }
    paint();
    requestAnimationFrame(tick);
  }

  function seekTo(ms: number) {
    leaveCopy();
    started = true;
    ended = false;
    paintDone();
    audio.currentTime = ms / 1000;
    jump(ms);
    if (audio.paused) void settle(ms);
  }

  function togglePlay() {
    if (copy) return continueLesson();
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
  const parserReady = import("../web/transpile.ts").then((m) => (parse = m.transpile));

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
    paintDone();
  };
  audio.onpause = () => {
    if (ended) return;
    rememberPosition();
    void settle(audio.currentTime * 1000);
  };
  audio.onended = finish;
  paintDone();

  if (demo) {
    root.classList.add("is-demo");
    audio.muted = true;
    audio.onpause = null;
    audio.onended = () => {
      advance(Infinity);
      setTimeout(() => {
        seekTo(0);
        void audio.play().catch(() => {});
      }, 2500);
    };
    resumeNote = "Click to watch this lesson with sound.";
    root.addEventListener("click", () => (window.top ?? window).location.assign(`/learn/${slug}`));
    void audio.play().catch(() => {}); // a browser that blocks even muted autoplay shows the first frame and the note
    requestAnimationFrame(tick);
    return;
  }

  playBtn.disabled = false;
  tryBtn.disabled = false;
  tryBtn.addEventListener("click", () => enterCopy());
  // Clicking into the lesson's code is how a student takes over; the caret lands where they clicked.
  view.dom.addEventListener("mousedown", (e) => {
    if (copy || (e.target as HTMLElement).closest(".cm-value-toggle, .cm-gutters")) return;
    e.preventDefault();
    enterCopy(view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined);
  });
  $("lp-continue").addEventListener("click", continueLesson);
  resetBtn.addEventListener("click", resetCopy);
  for (const tab of filesEl.querySelectorAll<HTMLButtonElement>("[data-file]")) {
    tab.addEventListener("click", () => {
      showCopyFile(tab.dataset.file as SlotId);
      view.focus();
    });
  }
  addEventListener("pagehide", () => {
    saveNow();
    if (!audio.paused) rememberPosition();
  });
  $("lp-end-try").addEventListener("click", () => enterCopy());
  $("lp-again").addEventListener("click", togglePlay);

  // Wait briefly for the account, so a copy or position from another device is here to open.
  await Promise.race([synced, new Promise((r) => setTimeout(r, 3000))]);
  paintDone();
  addEventListener("online", () => void syncAll());

  // Pick up where the student left off, at the last complete code before that point.
  const resumeAt = savedPosition(slug);
  if (resumeAt > 3000 && resumeAt < lesson.durationMs - 1000 && !location.search) {
    await parserReady;
    const at = parse ? completeAt(lesson, marks, resumeAt, parse) : resumeAt;
    audio.currentTime = at / 1000;
    jump(at);
    resumeNote = `Welcome back. We stopped at ${formatTime(at)}; press play to carry on.`;
  }
  const linked = new URLSearchParams(location.search).get("copy");
  if (linked && findCopy(slug, Number(linked))) enterCopy(undefined, Number(linked));
  else if (location.search) history.replaceState(null, "", location.pathname);
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
    if ((e.target as HTMLElement).closest("input, select, textarea, button, [contenteditable]")) return;
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
