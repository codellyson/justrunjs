// Recorded lessons: narration audio plus every editor change, timed against the audio.
// File ids are editor slots: "main" for a scratchpad tab, "html" / "css" / "js" for a playground.
import { ChangeSet, Text } from "@codemirror/state";

export type SlotId = "main" | "html" | "css" | "js";

export type LessonEvent =
  | { t: number; type: "change"; file: SlotId; changes: unknown }
  | { t: number; type: "select"; file: SlotId; anchor: number; head: number }
  | { t: number; type: "open"; file: SlotId }
  | { t: number; type: "run" };

export interface Lesson {
  version: 1;
  title: string;
  audio: string;
  durationMs: number;
  kind: "scratchpad" | "playground";
  language: "typescript" | "javascript";
  active: SlotId;
  files: { id: SlotId; content: string }[];
  events: LessonEvent[];
  /** Narration text; each line shows from `t` until the next one starts. */
  captions?: { t: number; text: string }[];
  /** What to try once the lesson ends, shown on the end card. */
  outro?: string;
}

/** Replay state; `next` is the index of the first event not yet applied. Text is immutable, so copies are cheap. */
export interface ReplayState {
  next: number;
  active: SlotId;
  docs: Map<SlotId, Text>;
  selections: Map<SlotId, { anchor: number; head: number }>;
}

const initial = (lesson: Lesson): ReplayState => ({
  next: 0,
  active: lesson.active,
  docs: new Map(lesson.files.map((f) => [f.id, Text.of(f.content.split("\n"))])),
  selections: new Map(),
});
const copy = (s: ReplayState): ReplayState => ({ ...s, docs: new Map(s.docs), selections: new Map(s.selections) });

/** Apply one event. Throws if a change does not fit its document, so a corrupt lesson stops instead of replaying garbage. */
export function step(s: ReplayState, e: LessonEvent): void {
  if (e.type === "change") s.docs.set(e.file, ChangeSet.fromJSON(e.changes).apply(s.docs.get(e.file)!));
  else if (e.type === "select") s.selections.set(e.file, { anchor: e.anchor, head: e.head });
  else if (e.type === "open") s.active = e.file;
  s.next++;
}

/** Rebuild the lesson as it was at `untilMs`, starting from a checkpoint when given one. */
export function replay(lesson: Lesson, untilMs = Infinity, from: ReplayState | null = null): ReplayState {
  const s = from ? copy(from) : initial(lesson);
  while (s.next < lesson.events.length && lesson.events[s.next].t <= untilMs) step(s, lesson.events[s.next]);
  return s;
}

/** A copy of the replay state every `every` events, for fast seeking. */
export function checkpoints(lesson: Lesson, every = 200): ReplayState[] {
  const s = initial(lesson);
  const out = [copy(s)];
  for (const e of lesson.events) {
    step(s, e);
    if (s.next % every === 0) out.push(copy(s));
  }
  return out;
}

/** Replay to `ms` from the latest checkpoint at or before it. */
export function seek(lesson: Lesson, marks: ReplayState[], ms: number): ReplayState {
  let from = marks[0];
  for (const m of marks) {
    if (m.next && lesson.events[m.next - 1].t > ms) break;
    from = m;
  }
  return replay(lesson, ms, from);
}
