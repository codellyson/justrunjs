// Where a student is in each lesson, and which lessons they've finished, on this device.
// The done list shares its key with the scratchpad's lesson tab, so both agree.
const DONE_KEY = "runjs.lessonsDone";
const POSITION_KEY = "runjs.lessonPositions";

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") ?? fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: progress just isn't remembered */
  }
}

export function doneLessons(): string[] {
  const done = read<unknown>(DONE_KEY, []);
  return Array.isArray(done) ? done : [];
}

export function markDone(slug: string) {
  const done = doneLessons();
  if (!done.includes(slug)) write(DONE_KEY, [...done, slug]);
}

/** Where the student stopped in this lesson, in ms; 0 when they haven't, or finished it. */
export function savedPosition(slug: string): number {
  const ms = read<Record<string, number>>(POSITION_KEY, {})[slug];
  return typeof ms === "number" && ms > 0 ? ms : 0;
}

export function savePosition(slug: string, ms: number) {
  const all = read<Record<string, number>>(POSITION_KEY, {});
  if (ms > 0) all[slug] = Math.round(ms);
  else delete all[slug];
  write(POSITION_KEY, all);
}
