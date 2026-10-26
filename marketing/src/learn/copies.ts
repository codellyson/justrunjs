// The student's own copies of a lesson's code, one per moment they stopped the lesson at.
// Kept on this device under their own key: the scratchpad rewrites its tab list wholesale, so
// sharing its storage could drop a copy made while /web/ was open in another tab.
import type { SlotId } from "../web/lesson.ts";

const KEY = "runjs.lessonCopies";

export interface LessonCopy {
  slug: string;
  /** The lesson moment this copy started from. */
  originMs: number;
  /** Text of each file (main for a scratchpad lesson; html, css, js for a page lesson). */
  files: Partial<Record<SlotId, string>>;
  /** The file on screen when the student last left it. */
  active: SlotId;
  /** The student's changes to each file since the copy started (ChangeSet JSON), to mark them. */
  edits: Partial<Record<SlotId, unknown>>;
  updatedAt: number;
}

function readAll(): LessonCopy[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

export function findCopy(slug: string, originMs: number): LessonCopy | undefined {
  return readAll().find((c) => c.slug === slug && c.originMs === originMs);
}

export function copiesOf(slug: string): LessonCopy[] {
  return readAll().filter((c) => c.slug === slug);
}

/** Save one copy, re-reading the others first so another open lesson's saves aren't lost. */
export function saveCopy(copy: LessonCopy): boolean {
  copy.updatedAt = Date.now();
  const others = readAll().filter((c) => !(c.slug === copy.slug && c.originMs === copy.originMs));
  try {
    localStorage.setItem(KEY, JSON.stringify([...others, copy]));
    return true;
  } catch {
    return false; // storage full or blocked: the page says it isn't saved
  }
}
