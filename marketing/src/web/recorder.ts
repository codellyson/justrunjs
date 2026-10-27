// Lesson recording, for the author: narrate into the microphone while working in a tab, and
// every edit, panel switch and run is logged against the audio clock. The result is a lesson
// JSON plus its audio, to put in public/lessons/; students watch it at /learn/<name>.
import { Annotation, Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import { formatTime, type Lesson, type LessonEvent, type SlotId } from "./lesson.ts";

/** Transactions that load a tab or panel into the editor; never author input. */
export const slotLoad = Annotation.define<boolean>();
export const slotLoadAnnotations = [slotLoad.of(true), Transaction.addToHistory.of(false)];

type Panel = "html" | "css" | "js";
type EventBody = { [K in LessonEvent["type"]]: Omit<Extract<LessonEvent, { type: K }>, "t"> }[LessonEvent["type"]];

/** A scratchpad tab, as the recorder and the account sync see it. */
export interface EditorTab {
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
  /** Set on an experiment forked from a lesson in the old in-editor player. */
  lesson?: { slug: string; originMs: number };
}

export interface RecorderContext {
  activeTab(): EditorTab;
  showToast(message: string): void;
}

const $ = (id: string) => document.getElementById(id)!;
const shownSlot = (t: EditorTab): SlotId => (t.kind === "playground" ? t.activePanel ?? "html" : "main");
const readSlot = (t: EditorTab, id: SlotId) => (id === "main" ? t.content : t[id]) ?? "";
const slotsOf = (t: EditorTab): SlotId[] => (t.kind === "playground" ? ["html", "css", "js"] : ["main"]);

export function initRecorder(ctx: RecorderContext) {
  const bar = $("lesson-bar");

  interface Recording {
    tabId: string;
    tabName: string;
    media: MediaRecorder;
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
        tabId: tab.id, tabName: tab.name, media, events: [], startedAt: performance.now(), pausedAt: 0, pausedTotal: 0,
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
      const title = prompt("Lesson title", r.tabName || "Untitled lesson") || "Untitled lesson";
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
    const name = done.lesson.audio.replace(/\.\w+$/, "");
    download(new Blob([JSON.stringify(done.lesson)], { type: "application/json" }), `${name}.json`);
    download(done.blob, done.lesson.audio);
    done.saved = true;
    ctx.showToast(`Saved. Put both files in public/lessons/ and add "${name}" to a playlist in src/learn/playlists.json to publish.`);
    render();
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

  // ---------- the bar under the editor, shown while recording ----------

  function button(label: string, onClick: () => void) {
    const b = document.createElement("button");
    b.className = "lesson-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
  const text = (value: string, className = "lesson-text") => Object.assign(document.createElement("span"), { className, textContent: value });
  const clock = text("", "lesson-time");

  function renderTime() {
    if (rec && !rec.done) clock.textContent = (rec.pausedAt ? "Paused " : "") + formatTime(elapsed());
  }

  function render() {
    const recording = !!rec && !rec.done;
    const btn = $("btn-record");
    btn.classList.toggle("recording", recording);
    btn.setAttribute("aria-pressed", String(recording));
    const label = recording ? "Stop recording" : "Record a lesson";
    btn.setAttribute("aria-label", label);
    btn.dataset.label = label;
    const items: Node[] = [];
    if (recording) {
      items.push(text("", "lesson-dot"), clock, button(rec!.pausedAt ? "Resume" : "Pause", togglePause), button("Stop", stopRecording));
    } else if (rec?.done) {
      items.push(
        text(`Recorded ${formatTime(rec.done.lesson.durationMs)} · ${rec.done.lesson.events.length} events`),
        button(rec.done.saved ? "Saved ✓" : "Save lesson", saveRecording),
        button("Discard", discardRecording),
      );
    }
    bar.replaceChildren(...items);
    bar.classList.toggle("hidden", !items.length);
    renderTime();
  }

  setInterval(() => rec && !rec.done && renderTime(), 250);

  return {
    /** Every editor update goes through here, so the author's edits and clicks are logged. */
    onUpdate(update: ViewUpdate): void {
      if (update.transactions.some((t) => t.annotation(slotLoad))) return;
      if (update.docChanged) record({ type: "change", file: shownSlot(ctx.activeTab()), changes: update.changes.toJSON() });
      else if (update.selectionSet) {
        const { anchor, head } = update.state.selection.main;
        record({ type: "select", file: shownSlot(ctx.activeTab()), anchor, head });
      }
    },
    onOpen(p: Panel) {
      record({ type: "open", file: p });
    },
    onRun() {
      record({ type: "run" });
    },
  };
}
