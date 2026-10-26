// Lesson mode: record a tab with narration, and play recorded lessons back in the editor.
// A learner's first edit to a playing lesson forks it into an ordinary tab (an "experiment"),
// so experiments save, share and reopen like any other tab.
import { Annotation, ChangeSet, Transaction, type AnnotationType } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { checkpoints, seek, step, type Lesson, type LessonEvent, type ReplayState, type SlotId } from "./lesson.ts";
import type { initAccount } from "./account.ts";

/** Transactions that load a tab or panel into the editor; never learner or author input. */
export const slotLoad = Annotation.define<boolean>();
/** Transactions applied by lesson playback; never learner or author input. */
const replayed = Annotation.define<boolean>();
const quiet = (a: AnnotationType<boolean>) => [a.of(true), Transaction.addToHistory.of(false)];
export const slotLoadAnnotations = quiet(slotLoad);

type Panel = "html" | "css" | "js";
type EventBody = { [K in LessonEvent["type"]]: Omit<Extract<LessonEvent, { type: K }>, "t"> }[LessonEvent["type"]];

export interface LessonTab {
  id: string;
  name: string;
  kind: "scratchpad" | "playground";
  content: string;
  language: "typescript" | "javascript";
  html?: string;
  css?: string;
  js?: string;
  jsLanguage?: "typescript" | "javascript";
  activePanel?: Panel;
  /** Set on the tab that plays a lesson; that tab is never persisted. */
  lessonSource?: string;
  /** Set on an experiment forked from a lesson. */
  lesson?: { slug: string; originMs: number };
}

export interface LessonContext {
  account: ReturnType<typeof initAccount>;
  editor: EditorView;
  tabs(): LessonTab[];
  activeTab(): LessonTab;
  /** Point the app at another tab without touching the editor (it already shows that tab's text). */
  setActiveId(id: string): void;
  activateTab(id: string): void;
  switchPanel(p: Panel): void;
  loadActiveIntoEditor(): void;
  refreshChrome(): void;
  runActive(): void;
  uniqueTabName(name: string): string;
  showToast(message: string): void;
}

const $ = (id: string) => document.getElementById(id)!;
const formatTime = (ms: number) => {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
};
const shownSlot = (t: LessonTab): SlotId => (t.kind === "playground" ? t.activePanel ?? "html" : "main");
const readSlot = (t: LessonTab, id: SlotId) => (id === "main" ? t.content : t[id]) ?? "";
function writeSlot(t: LessonTab, id: SlotId, value: string) {
  if (id === "main") t.content = value;
  else t[id] = value;
}
const slotsOf = (t: LessonTab): SlotId[] => (t.kind === "playground" ? ["html", "css", "js"] : ["main"]);

export function initLessonMode(ctx: LessonContext) {
  const bar = $("lesson-bar");

  // ---------- recording ----------

  interface Recording {
    tabId: string;
    media: MediaRecorder;
    chunks: Blob[];
    events: LessonEvent[];
    startedAt: number;
    pausedAt: number;
    pausedTotal: number;
    lesson: Omit<Lesson, "events" | "durationMs" | "audio" | "title">;
    done?: { lesson: Lesson; blob: Blob; saved: boolean };
  }
  let rec: Recording | null = null;

  const elapsed = () => {
    if (!rec) return 0;
    return Math.round((rec.pausedAt || performance.now()) - rec.startedAt - rec.pausedTotal);
  };
  // Edits while paused keep the frozen time, so they appear at once when the lesson reaches that point.
  const record = (e: EventBody) => {
    if (rec && !rec.done && ctx.activeTab().id === rec.tabId) rec.events.push({ t: elapsed(), ...e } as LessonEvent);
  };

  async function startRecording() {
    const tab = ctx.activeTab();
    if (tab.lessonSource) return ctx.showToast("Open your own tab to record a lesson.");
    if (rec?.done && !rec.done.saved && !confirm("Discard the unsaved recording and start a new one?")) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      return ctx.showToast(`Microphone unavailable: ${(e as Error).message}`);
    }
    const media = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    media.ondataavailable = (e) => chunks.push(e.data);
    media.onstart = () => {
      rec = {
        tabId: tab.id, media, chunks, events: [], startedAt: performance.now(), pausedAt: 0, pausedTotal: 0,
        lesson: {
          version: 1,
          kind: tab.kind,
          language: (tab.kind === "playground" ? tab.jsLanguage : tab.language) ?? "javascript",
          active: shownSlot(tab),
          files: slotsOf(tab).map((id) => ({ id, content: readSlot(tab, id) })),
        },
      };
      render();
    };
    media.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const r = rec!;
      const type = media.mimeType || "audio/webm";
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      const title = prompt("Lesson title", ctx.tabs().find((t) => t.id === r.tabId)?.name ?? "Untitled lesson") || "Untitled lesson";
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lesson";
      r.done = {
        lesson: { ...r.lesson, title, audio: `${slug}.${ext}`, durationMs: elapsed(), events: r.events },
        blob: new Blob(chunks, { type }),
        saved: false,
      };
      render();
    };
    media.start(1000);
  }

  function togglePause() {
    if (!rec) return;
    if (rec.pausedAt) {
      rec.pausedTotal += performance.now() - rec.pausedAt;
      rec.pausedAt = 0;
      rec.media.resume();
    } else {
      rec.pausedAt = performance.now();
      rec.media.pause();
    }
    render();
  }

  function stopRecording() {
    if (!rec) return;
    if (rec.pausedAt) togglePause();
    rec.pausedAt = performance.now(); // freeze the clock at the stop moment
    rec.media.stop();
  }

  function download(blob: Blob, name: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function saveRecording() {
    const done = rec!.done!;
    download(new Blob([JSON.stringify(done.lesson)], { type: "application/json" }), done.lesson.audio.replace(/\.\w+$/, ".json"));
    download(done.blob, done.lesson.audio);
    done.saved = true;
    ctx.showToast("Saved. Put both files in public/lessons/ to publish.");
  }

  function discardRecording() {
    if (rec?.done && !rec.done.saved && !confirm("Discard this recording?")) return;
    rec = null;
    render();
  }

  $("btn-record").addEventListener("click", () => (rec && !rec.done ? stopRecording() : startRecording()));
  addEventListener("beforeunload", (e) => {
    if (rec && (!rec.done || !rec.done.saved)) e.preventDefault();
  });

  // ---------- playback ----------

  const slug = new URLSearchParams(location.search).get("lesson");
  const audio = new Audio();
  let lesson: Lesson | null = null;
  let marks: ReplayState[] = [];
  let s: ReplayState | null = null;
  let shownMs = 0;
  let lessonTab: LessonTab | null = null;

  const onLessonTab = () => !!lessonTab && ctx.activeTab().id === lessonTab.id;
  const editorQuiet = { annotations: quiet(replayed) };

  /** Rebuild the lesson tab at `ms` from the nearest checkpoint. */
  function jump(ms: number) {
    s = seek(lesson!, marks, ms);
    shownMs = ms;
    for (const [id, doc] of s.docs) writeSlot(lessonTab!, id, doc.toString());
    if (lessonTab!.kind === "playground") lessonTab!.activePanel = s.active as Panel;
    if (!onLessonTab()) return;
    ctx.loadActiveIntoEditor();
    ctx.refreshChrome();
    const sel = s.selections.get(shownSlot(lessonTab!));
    if (sel) select(sel.anchor, sel.head);
    ctx.runActive();
  }

  function select(anchor: number, head: number) {
    const len = ctx.editor.state.doc.length;
    ctx.editor.dispatch({ selection: { anchor: Math.min(anchor, len), head: Math.min(head, len) }, scrollIntoView: true, ...editorQuiet });
  }

  /** Apply the events between the last frame and `ms` to the live editor. */
  function advance(ms: number) {
    if (ms < shownMs || ms - shownMs > 2000) return jump(ms);
    while (s!.next < lesson!.events.length && lesson!.events[s!.next].t <= ms) {
      const e = lesson!.events[s!.next];
      step(s!, e);
      if (e.type === "open") {
        if (lessonTab!.kind === "playground") ctx.switchPanel(e.file as Panel);
      } else if (e.type === "run") ctx.runActive();
      else if (e.file !== shownSlot(lessonTab!)) {
        if (e.type === "change") writeSlot(lessonTab!, e.file, s!.docs.get(e.file)!.toString());
      } else if (e.type === "change") ctx.editor.dispatch({ changes: ChangeSet.fromJSON(e.changes), ...editorQuiet });
      else select(e.anchor, e.head);
    }
    shownMs = ms;
  }

  function fork(update: ViewUpdate) {
    audio.pause();
    shownMs = Math.round(shownMs);
    const from = lessonTab!;
    const exp: LessonTab = {
      ...from,
      id: "t-" + Date.now(),
      name: ctx.uniqueTabName(`${lesson!.title} @ ${formatTime(shownMs)}${from.kind === "playground" ? ".html" : lesson!.language === "typescript" ? ".ts" : ".js"}`),
      lessonSource: undefined,
      lesson: { slug: slug!, originMs: shownMs },
    };
    writeSlot(exp, shownSlot(from), update.state.doc.toString());
    // The edit is already in the editor, so only re-point the app; the lesson tab keeps the teacher's text.
    ctx.tabs().push(exp);
    ctx.setActiveId(exp.id);
    queueMicrotask(() => {
      ctx.refreshChrome();
      render();
      ctx.showToast("Your edit started an experiment. The lesson is unchanged.");
    });
  }

  function backToLesson(play = false) {
    const t = ctx.activeTab();
    const origin = t.lesson?.slug === slug ? t.lesson.originMs : shownMs;
    ctx.activateTab(lessonTab!.id);
    audio.currentTime = origin / 1000;
    jump(origin);
    if (play) void audio.play().catch((e) => ctx.showToast(`Could not play audio: ${e.message}`));
    render();
  }

  function togglePlay() {
    if (!onLessonTab()) return backToLesson(true);
    if (audio.paused) void audio.play().catch((e) => ctx.showToast(`Could not play audio: ${e.message}`));
    else audio.pause();
  }

  // Progress: saved on pause, at the end, and every 10s of playback, for signed-in learners.
  let lastSaved = 0;
  const saveProgress = (completed = false) => {
    lastSaved = performance.now();
    ctx.account.saveProgress(slug!, audio.currentTime * 1000, completed || audio.currentTime * 1000 >= lesson!.durationMs - 1000);
  };
  // Resume once, as soon as the account's progress for this lesson is known.
  let resumed = false;
  function resume() {
    const p = lesson && !resumed && ctx.account.progressFor(slug!);
    if (!p) return;
    resumed = true;
    if (!audio.paused || shownMs > 0 || p.completed || p.positionMs < 3000) return;
    audio.currentTime = p.positionMs / 1000;
    jump(p.positionMs);
    ctx.showToast(`Picked up where you left off, at ${formatTime(p.positionMs)}.`);
  }
  ctx.account.onChange(() => {
    resume();
    render();
  });

  function tick() {
    if (onLessonTab() && !audio.paused) {
      advance(audio.currentTime * 1000);
      if (performance.now() - lastSaved > 10_000) saveProgress();
    }
    renderTime();
    requestAnimationFrame(tick);
  }

  async function loadLesson(name: string) {
    try {
      const res = await fetch(`/lessons/${encodeURIComponent(name)}.json`);
      if (!res.ok) throw new Error(`Lesson "${name}" not found (${res.status})`);
      lesson = (await res.json()) as Lesson;
      marks = checkpoints(lesson);
      // A blob URL is always seekable, whatever Range support the host has.
      const media = await fetch(`/lessons/${lesson.audio}`);
      if (!media.ok) throw new Error(`Audio for "${name}" not found (${media.status})`);
      audio.src = URL.createObjectURL(await media.blob());
    } catch (e) {
      ctx.showToast((e as Error).message);
      return;
    }
    audio.onended = () => {
      advance(Infinity);
      saveProgress(true);
    };
    audio.onplay = render;
    audio.onpause = () => {
      saveProgress();
      render();
    };
    const files = new Map(lesson.files.map((f) => [f.id, f.content]));
    lessonTab = {
      id: `lesson-${name}`,
      name: `▶ ${lesson.title}`,
      kind: lesson.kind,
      content: files.get("main") ?? "",
      language: lesson.language,
      html: files.get("html"),
      css: files.get("css"),
      js: files.get("js"),
      jsLanguage: lesson.language,
      activePanel: lesson.kind === "playground" ? (lesson.active as Panel) : undefined,
      lessonSource: name,
    };
    ctx.tabs().unshift(lessonTab);
    ctx.activateTab(lessonTab.id);
    jump(0);
    resume();
    render();
    tick();
  }

  // ---------- the bar under the editor ----------

  function button(label: string, onClick: () => void, title = label) {
    const b = document.createElement("button");
    b.className = "lesson-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  const text = (value: string, className = "lesson-text") => Object.assign(document.createElement("span"), { className, textContent: value });

  const clock = text("", "lesson-time");
  const range = Object.assign(document.createElement("input"), { type: "range", min: "0", step: "100", className: "lesson-seek" });
  range.setAttribute("aria-label", "Lesson position");
  range.addEventListener("input", () => {
    if (!onLessonTab()) backToLesson();
    audio.currentTime = Number(range.value) / 1000;
    jump(Number(range.value));
  });
  const speed = document.createElement("select");
  speed.className = "lesson-btn";
  speed.setAttribute("aria-label", "Speed");
  for (const r of ["0.75", "1", "1.25", "1.5", "2"]) speed.append(new Option(`${r}×`, r, r === "1", r === "1"));
  speed.addEventListener("change", () => { audio.playbackRate = Number(speed.value); });

  function renderTime() {
    if (rec && !rec.done) {
      clock.textContent = (rec.pausedAt ? "Paused " : "") + formatTime(elapsed());
      return;
    }
    if (!lesson) return;
    const t = ctx.activeTab();
    const ms = onLessonTab() ? audio.currentTime * 1000 : t.lesson?.slug === slug ? t.lesson!.originMs : shownMs;
    clock.textContent = `${formatTime(ms)} / ${formatTime(lesson.durationMs)}`;
    if (document.activeElement !== range) range.value = String(ms);
  }

  function render() {
    $("btn-record").classList.toggle("recording", !!rec && !rec.done);
    $("btn-record").title = rec && !rec.done ? "Stop recording" : "Record a lesson";
    const items: Node[] = [];
    if (rec && !rec.done) {
      items.push(text("", "lesson-dot"), clock, button(rec.pausedAt ? "Resume" : "Pause", togglePause), button("Stop", stopRecording));
    } else if (rec?.done) {
      items.push(
        text(`Recorded ${formatTime(rec.done.lesson.durationMs)} · ${rec.done.lesson.events.length} events`),
        button(rec.done.saved ? "Saved ✓" : "Save lesson", saveRecording),
        button("Discard", discardRecording),
      );
    } else if (lesson) {
      const t = ctx.activeTab();
      const mine = t.lesson?.slug === slug;
      range.max = String(lesson.durationMs);
      items.push(button(onLessonTab() && !audio.paused ? "❚❚ Pause" : "▶ Play", togglePlay), clock, range, speed);
      if (mine) {
        items.push(
          text(`Your experiment · from ${formatTime(t.lesson!.originMs)}`, "lesson-mode"),
          button("↩ Back to lesson", () => backToLesson()),
          text(ctx.account.statusText(t)),
        );
      }
    }
    bar.replaceChildren(...items);
    bar.classList.toggle("hidden", !items.length);
    renderTime();
  }

  if (slug) void loadLesson(slug);
  setInterval(() => rec && !rec.done && renderTime(), 250);

  return {
    /** Every editor update goes through here before the app's own handling. */
    onUpdate(update: ViewUpdate) {
      const tr = update.transactions;
      if (tr.some((t) => t.annotation(slotLoad) || t.annotation(replayed))) return;
      if (onLessonTab() && update.docChanged) return fork(update);
      if (update.docChanged) record({ type: "change", file: shownSlot(ctx.activeTab()), changes: update.changes.toJSON() });
      else if (update.selectionSet) {
        const { anchor, head } = update.state.selection.main;
        record({ type: "select", file: shownSlot(ctx.activeTab()), anchor, head });
      }
    },
    onOpen(p: Panel) { record({ type: "open", file: p }); },
    onRun() { record({ type: "run" }); },
    /** Tab switches change what the bar offers (Back to lesson, Play). */
    onTabChange: render,
  };
}
