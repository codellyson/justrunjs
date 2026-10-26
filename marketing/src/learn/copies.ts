// The student's own copies of a lesson's code, one per moment they stopped the lesson at.
// Kept on this device under their own key (the scratchpad rewrites its tab list wholesale, so
// sharing its storage could drop a copy made while /web/ was open in another tab), and synced
// to the student's account when they're signed in (sync.ts).
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
  /** The account's updatedAt for this copy when it was last in step; unset if never synced. */
  syncedAt?: number;
  /** False after a change on this device that the account doesn't have yet. */
  synced?: boolean;
}

export function allCopies(): LessonCopy[] {
  return readAll();
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

/** Save the student's change to a copy, re-reading the others first so another open lesson's saves aren't lost. */
export function saveCopy(copy: LessonCopy): boolean {
  copy.updatedAt = Date.now();
  copy.synced = false;
  return storeCopy(copy);
}

/** Write a copy as it is (sync bookkeeping, or a copy that came from the account). */
export function storeCopy(copy: LessonCopy): boolean {
  const others = readAll().filter((c) => !(c.slug === copy.slug && c.originMs === copy.originMs));
  try {
    localStorage.setItem(KEY, JSON.stringify([...others, copy]));
    return true;
  } catch {
    return false; // storage full or blocked: the page says it isn't saved
  }
}
