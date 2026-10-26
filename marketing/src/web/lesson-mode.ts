// Lesson mode: record a tab with narration, and play recorded lessons back in the editor.
// A learner's first edit to a playing lesson forks it into an ordinary tab (an "experiment"),
// so experiments save, share and reopen like any other tab.
import { Annotation, ChangeSet, Transaction, type AnnotationType, type Text } from "@codemirror/state";
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
    shownMs = Math.min(ms, lesson!.durationMs); // the end arrives as Infinity
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
    shownMs = Math.min(ms, lesson!.durationMs); // the end arrives as Infinity
  }

  /** Copy the lesson tab into a student's experiment. `edited` is the editor text when an edit triggered it. */
  /**
   * Copy the lesson tab into a student's experiment. When a keystroke triggered it (`change`,
   * applied to the lesson's current text), the experiment starts from the last complete code
   * instead: the student's edit is mapped back over the instructor's half-typed characters.
   */
  function fork(edited?: string, message = "Your edit started an experiment. The lesson is unchanged.", change?: ChangeSet) {
    audio.pause();
    shownMs = Math.round(shownMs);
    const from = lessonTab!;
    const slot = shownSlot(from);
    let origin = shownMs;
    let base: Map<SlotId, Text> | null = null;
    let cursor: number | null = null;
    const clean = change ? completeAt(shownMs) : shownMs;
    if (change && clean < shownMs) {
      const cleanState = seek(lesson!, marks, clean);
      const cleanDoc = cleanState.docs.get(slot)!;
      // The instructor's edits to this file since the clean point, as one change…
      let since: ChangeSet | null = null;
      for (const e of lesson!.events) {
        if (e.t > clean && e.t <= shownMs && e.type === "change" && e.file === slot) {
          const cs = ChangeSet.fromJSON(e.changes);
          since = since ? since.compose(cs) : cs;
        }
      }
      // …undone, with the student's keystroke carried over onto the clean text.
      const mine = since ? change.map(since.invert(cleanDoc)) : change;
      base = cleanState.docs;
      base.set(slot, mine.apply(cleanDoc));
      mine.iterChanges((_fa, _ta, _fb, toB) => (cursor = toB));
      origin = clean;
      edited = undefined;
    }
    const exp: LessonTab = {
      ...from,
      id: "t-" + Date.now(),
      name: ctx.uniqueTabName(`${lesson!.title} (experiment from ${formatTime(origin)})`),
      lessonSource: undefined,
      lesson: { slug: slug!, originMs: origin },
    };
    if (base) for (const [id, doc] of base) writeSlot(exp, id, doc.toString());
    if (edited !== undefined) writeSlot(exp, shownSlot(from), edited);
    // The editor already shows this text, so only re-point the app; the lesson tab keeps the teacher's text.
    ctx.tabs().push(exp);
    ctx.setActiveId(exp.id);
    queueMicrotask(() => {
      if (base) {
        // The editor still shows the half-typed text; load the rebased copy and keep the caret
        // where the student was typing.
        ctx.loadActiveIntoEditor();
        if (cursor !== null) ctx.editor.dispatch({ selection: { anchor: Math.min(cursor, ctx.editor.state.doc.length) } });
      }
      ctx.refreshChrome();
      render();
      ctx.showToast(message);
    });
    return !!base;
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
  // Finished lessons, remembered on this device (signed-in progress also counts).
  const DONE_KEY = "runjs.lessonsDone";
  const doneHere = (): string[] => {
    try {
      return JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]");
    } catch {
      return [];
    }
  };
  const isDone = (s: string) => doneHere().includes(s) || !!ctx.account.progressFor(s)?.completed;
  function markDone() {
    if (!isDone(slug!)) localStorage.setItem(DONE_KEY, JSON.stringify([...doneHere(), slug]));
    paintDoneMarks();
  }
  /** The published lessons, in the order the Examples & lessons list shows them. */
  const lessonLinks = () =>
    [...document.querySelectorAll<HTMLAnchorElement>('#examples-popover a.example-item[href*="?lesson="]')].map((a) => ({
      a,
      slug: new URL(a.href).searchParams.get("lesson")!,
      title: a.querySelector(".example-title")?.textContent ?? "",
    }));
  function paintDoneMarks() {
    for (const { a, slug: s } of lessonLinks()) {
      const blurb = a.querySelector<HTMLElement>(".example-blurb");
      if (!blurb) continue;
      blurb.dataset.base ??= blurb.textContent ?? "";
      blurb.textContent = blurb.dataset.base + (isDone(s) ? " · Done ✓" : "");
    }
  }
  function nextLessonButton() {
    const all = lessonLinks();
    const at = all.findIndex((l) => l.slug === slug);
    const next = [...all.slice(at + 1), ...all.slice(0, Math.max(0, at))].find((l) => !isDone(l.slug));
    return next ? [button(`Next lesson: ${next.title} →`, () => (location.href = next.a.href))] : [];
  }

  const saveProgress = (completed = false) => {
    lastSaved = performance.now();
    ctx.account.saveProgress(slug!, audio.currentTime * 1000, completed || audio.currentTime * 1000 >= lesson!.durationMs - 1000);
  };
  // Resume once, as soon as the account's progress for this lesson is known.
  let resumed = false;
  // The instructor types a character at a time, so most moments in a lesson are mid-keystroke.
  // When the lesson stops somewhere (pause, scrub, arrow keys, resume), step back to the latest
  // moment where its script is complete code, and rewind the audio to match.
  const scriptSlot = (): SlotId => (lesson!.kind === "playground" ? "js" : "main");
  // Loaded with the lesson, so the check can run synchronously (a fork happens mid-keystroke).
  let transpile: ((src: string) => unknown) | null = null;
  function completeAt(ms: number): number {
    if (!transpile) return ms;
    const parse = transpile;
    const slot = scriptSlot();
    // "Complete" means it parses; best is also at the end of a finished line, so a pause
    // shows `nums.map(…);` rather than a valid-but-half-typed `nums.ma`.
    const check = (t: number) => {
      const docs = seek(lesson!, marks, t).docs;
      try {
        parse(docs.get(slot)?.toString() ?? "");
      } catch {
        return 0;
      }
      // Best: every file (HTML and CSS too) ends on a finished line, so nothing is mid-word.
      const settled = [...docs.values()].every((d) => {
        const text = d.toString();
        return text === "" || text.endsWith("\n");
      });
      return settled ? 2 : 1;
    };
    const atMs = check(ms);
    if (atMs === 2) return ms;
    const times = lesson!.events.filter((e) => e.t <= ms && e.type === "change").map((e) => e.t);
    let fallback = atMs ? ms : -1;
    for (let i = times.length - 1; i >= 0; i--) {
      if (ms - times[i] > 30_000) break; // nothing clean nearby: settle for what we found
      if (times[i] === times[i + 1]) continue; // same moment; the later event was already checked
      const c = check(times[i]);
      if (c === 2) return times[i];
      if (c === 1 && fallback < 0) fallback = times[i];
    }
    return fallback >= 0 ? fallback : ms;
  }
  let snapGen = 0;
  async function settleAt(ms: number) {
    const gen = ++snapGen;
    const clean = completeAt(ms);
    await Promise.resolve(); // let a Play click in the same task win
    // Only if nothing moved on meanwhile (another seek, Play, or leaving the lesson tab).
    if (gen !== snapGen || clean >= ms - 1 || !audio.paused || !onLessonTab()) return;
    audio.currentTime = clean / 1000;
    jump(clean);
  }

  function resume() {
    const p = lesson && !resumed && ctx.account.progressFor(slug!);
    if (!p) return;
    resumed = true;
    if (!audio.paused || shownMs > 0 || p.completed || p.positionMs < 3000) return;
    audio.currentTime = p.positionMs / 1000;
    jump(p.positionMs);
    started = true; // the caption at this point, not "Press Play to start"
    void settleAt(p.positionMs);
    ctx.showToast(`Picked up where you left off, at ${formatTime(p.positionMs)}.`);
  }
  ctx.account.onChange(() => {
    resume();
    render();
    paintDoneMarks();
  });
  paintDoneMarks();

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
      transpile = (await import("./transpile.ts")).transpile;
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
      markDone();
      ended = true;
      render();
    };
    audio.onplay = () => {
      started = true;
      ended = false;
      render();
    };
    audio.onpause = () => {
      saveProgress();
      render();
      if (onLessonTab() && !ended) void settleAt(audio.currentTime * 1000);
    };
    const files = new Map(lesson.files.map((f) => [f.id, f.content]));
    lessonTab = {
      id: `lesson-${name}`,
      name: lesson.title,
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

  function button(label: string, onClick: () => void, title = label, primary = false) {
    const b = document.createElement("button");
    b.className = "lesson-btn" + (primary ? " primary" : "");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }
  const text = (value: string, className = "lesson-text") => Object.assign(document.createElement("span"), { className, textContent: value });

  const clock = text("", "lesson-time");
  const INTRO = "Press Play to start. Pause anytime and edit the code: your edits start your own experiment, and the lesson stays as it is.";
  const caption = text("", "lesson-caption");
  let started = false; // the intro shows until the lesson is played or scrubbed
  let ended = false;
  const range = Object.assign(document.createElement("input"), { type: "range", min: "0", step: "100", className: "lesson-seek" });
  range.setAttribute("aria-label", "Lesson position");
  range.addEventListener("input", () => {
    if (!onLessonTab()) backToLesson();
    started = true;
    if (ended) {
      ended = false;
      render();
    }
    audio.currentTime = Number(range.value) / 1000;
    jump(Number(range.value));
    if (audio.paused) void settleAt(Number(range.value));
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
    const line = !started ? INTRO : currentCaption(ms);
    if (caption.textContent !== line) {
      caption.textContent = line;
      caption.title = line; // full text when a small screen clamps it
    }
    caption.classList.toggle("lesson-intro", !started);
  }

  function currentCaption(ms: number) {
    let line = "";
    for (const c of lesson?.captions ?? []) {
      if (c.t > ms) break;
      line = c.text;
    }
    return line;
  }

  /** The student's most recent experiment from this lesson, if any. */
  const latestExperiment = () => ctx.tabs().filter((t) => t.lesson?.slug === slug).at(-1);

  function replay() {
    ended = false;
    audio.currentTime = 0;
    jump(0);
    void audio.play().catch((e) => ctx.showToast(`Could not play audio: ${e.message}`));
  }

  function render() {
    $("btn-record").classList.toggle("recording", !!rec && !rec.done);
    $("btn-record").setAttribute("aria-pressed", String(!!rec && !rec.done));
    const recLabel = rec && !rec.done ? "Stop recording" : "Record a lesson";
    $("btn-record").setAttribute("aria-label", recLabel);
    $("btn-record").dataset.label = recLabel;
    const items: Node[] = [];
    if (rec && !rec.done) {
      items.push(text("", "lesson-dot"), clock, button(rec.pausedAt ? "Resume" : "Pause", togglePause), button("Stop", stopRecording));
    } else if (rec?.done) {
      items.push(
        text(`Recorded ${formatTime(rec.done.lesson.durationMs)} · ${rec.done.lesson.events.length} events`),
        button(rec.done.saved ? "Saved ✓" : "Save lesson", saveRecording),
        button("Discard", discardRecording),
      );
    } else if (lesson && onLessonTab() && ended) {
      const exp = latestExperiment();
      items.push(
        text("Lesson complete.", "lesson-done"),
        ...(lesson.outro ? [text(lesson.outro, "lesson-caption")] : []),
        // Your turn comes first, from the finished code the outro talks about; an older
        // experiment (forked mid-lesson) is offered second, then replaying.
        button("Try it yourself", () => fork(undefined, "This experiment starts from the finished lesson. Change anything; the lesson stays as it is."), undefined, true),
        ...(exp ? [button("Open your earlier experiment", () => ctx.activateTab(exp.id))] : []),
        button("↺ Replay", replay),
        ...nextLessonButton(),
      );
    } else if (lesson) {
      const exp = onLessonTab() ? latestExperiment() : undefined;
      range.max = String(lesson.durationMs);
      if (onLessonTab()) items.push(caption);
      // Before the lesson starts, Play is the one obvious thing to press.
      const fresh = onLessonTab() && !started;
      const playLabel = onLessonTab() && !audio.paused ? "❚❚ Pause" : fresh ? "▶ Play lesson" : "▶ Play";
      items.push(button(playLabel, togglePlay, "Play or pause (Space); ←/→ jump 5s", fresh), clock, range, speed);
      if (exp) items.push(button("Open your experiment", () => ctx.activateTab(exp.id)));
    }
    // Re-rendering replaces the buttons; keep keyboard focus on the same control.
    const focusedAt = [...bar.querySelectorAll("button, select, input")].indexOf(document.activeElement as Element);
    bar.replaceChildren(...items);
    if (focusedAt >= 0) bar.querySelectorAll<HTMLElement>("button, select, input")[focusedAt]?.focus();
    bar.classList.toggle("hidden", !items.length);
    renderHead();
    renderTime();
  }

  function renderHead() {
    const t = ctx.activeTab();
    const head = $("lesson-head");
    const items: Node[] = [];
    const inLesson = !!lesson && onLessonTab();
    if (inLesson) {
      const playing = !audio.paused;
      const state = ended ? "Finished" : playing ? "Playing" : started ? `Paused at ${formatTime(audio.currentTime * 1000)}` : "Not started";
      items.push(text("Lesson", "lesson-head-label"), text(lesson!.title, "lesson-head-title"), text(state, "lesson-head-state" + (playing ? " playing" : "")));
    } else if (t.lesson) {
      const same = !!lesson && t.lesson.slug === slug;
      items.push(
        text("Your experiment", "lesson-head-label"),
        text(`from ${same ? lesson!.title : "a lesson"} at ${formatTime(t.lesson.originMs)}`, "lesson-head-title"),
      );
      if (same) items.push(button("↩ Back to lesson", () => backToLesson()));
      else {
        const a = Object.assign(document.createElement("a"), { className: "lesson-btn", href: `/web/?lesson=${encodeURIComponent(t.lesson.slug)}`, textContent: "Open the lesson" });
        items.push(a);
      }
    }
    head.replaceChildren(...items);
    head.classList.toggle("hidden", !items.length);
    $("editor").dataset.mode = inLesson ? "lesson" : t.lesson ? "experiment" : "";
  }

  // Space plays or pauses and ←/→ jump 5s, unless focus is in the code or a field that uses those keys.
  window.addEventListener("keydown", (e) => {
    if (!lesson || !onLessonTab() || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.closest(".cm-editor, input, select, textarea, [contenteditable]")) return;
    if (e.key === " " && !el.closest("button, [role=tab]")) {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const ms = Math.min(lesson.durationMs, Math.max(0, audio.currentTime * 1000 + (e.key === "ArrowRight" ? 5000 : -5000)));
      started = true;
      audio.currentTime = ms / 1000;
      jump(ms);
      if (audio.paused) void settleAt(ms);
    }
  });

  if (slug) void loadLesson(slug);
  setInterval(() => rec && !rec.done && renderTime(), 250);

  return {
    /** Every editor update goes through here before the app's own handling; true means "handled, don't save". */
    onUpdate(update: ViewUpdate): boolean | void {
      const tr = update.transactions;
      if (tr.some((t) => t.annotation(slotLoad) || t.annotation(replayed))) return;
      // True when the fork replaced the editor's text, so the app must not save what it shows now.
      if (onLessonTab() && update.docChanged) return fork(update.state.doc.toString(), undefined, update.changes);
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
    /** True while a lesson is playing on screen (its replayed typing is in progress). */
    isPlaying: () => onLessonTab() && !audio.paused,
  };
}
