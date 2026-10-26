// Keeps a signed-in student's lesson copies, finished lessons and lesson positions in their
// account, so they follow them to every device. Signed out, everything stays in this browser.
// Same API and sign-in as the scratchpad (worker/index.ts).
import { allCopies, storeCopy, type LessonCopy } from "./copies.ts";
import { doneLessons, markDone, savePosition, savedPosition } from "./progress.ts";

type Reply<T> = { ok: boolean; status: number; data: T };
async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<Reply<T>> {
  try {
    const res = await fetch(path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as T };
  } catch {
    return { ok: false, status: 0, data: {} as T }; // offline or the server is unreachable
  }
}

let who: Promise<string | null> | null = null;
/** The signed-in student's email, or null. Asked once per page. */
export function signedInEmail(): Promise<string | null> {
  who ??= call<{ email?: string }>("/api/me").then((r) => (r.ok && r.data.email ? r.data.email : null));
  return who;
}

// ---------- sign in and out ----------

const errorOf = (r: Reply<{ error?: string }>) =>
  r.status === 0 ? "Couldn't reach the server. Check your connection and try again." : r.data.error ?? `Something went wrong (${r.status}).`;

export async function requestCode(email: string): Promise<string | null> {
  const r = await call<{ error?: string }>("/api/auth/request", { method: "POST", body: { email, from: "learn" } });
  return r.ok ? null : errorOf(r);
}

export async function verifyCode(email: string, code: string): Promise<string | null> {
  const r = await call<{ error?: string; email?: string }>("/api/auth/code", { method: "POST", body: { email, code } });
  if (!r.ok) return errorOf(r);
  who = Promise.resolve(r.data.email ?? email);
  return null;
}

/** Sign out of this browser. Copies and progress stay here; the account keeps its own. */
export async function signOut() {
  await call("/api/auth/logout", { method: "POST" });
  who = Promise.resolve(null);
}

// ---------- copies ----------

const keyOf = (c: Pick<LessonCopy, "slug" | "originMs">) => `${c.slug}@${c.originMs}`;
const content = (c: LessonCopy) => JSON.stringify([c.files, c.edits]);
// What the account stores: the copy without this device's bookkeeping.
const payload = ({ syncedAt: _a, synced: _b, ...copy }: LessonCopy) => copy;

/**
 * Two devices changed the same copy: keep both. Theirs moves to the next free moment, so it
 * shows as another copy from the same point in the lesson, and uploads as a copy of its own.
 */
function keepTheirs(theirs: LessonCopy) {
  const taken = new Set(allCopies().map(keyOf));
  let origin = theirs.originMs + 1;
  while (taken.has(keyOf({ slug: theirs.slug, originMs: origin }))) origin++;
  const moved: LessonCopy = { ...theirs, originMs: origin, syncedAt: undefined, synced: false };
  storeCopy(moved);
  void pushCopy(moved);
}

const pushing = new Map<string, { again: boolean }>();
export type SaveState = "account" | "device" | "failed";

/** Upload a copy. "device" when signed out; "failed" keeps it here and tries again on the next save. */
export async function pushCopy(copy: LessonCopy): Promise<SaveState> {
  if (!(await signedInEmail())) return "device";
  const key = keyOf(copy);
  const running = pushing.get(key);
  if (running) {
    running.again = true; // the request in flight re-sends once it lands
    return "account";
  }
  pushing.set(key, { again: false });
  let state: SaveState = "failed";
  try {
    for (let tries = 0; tries < 3; tries++) {
      const sentAt = copy.updatedAt;
      const r = await call<{ updatedAt?: number; conflict?: boolean; copy?: LessonCopy }>(
        `/api/copies/${encodeURIComponent(copy.slug)}/${copy.originMs}`,
        { method: "PUT", body: { copy: payload(copy), base: copy.syncedAt ?? null } },
      );
      if (r.ok && r.data.updatedAt) {
        copy.syncedAt = r.data.updatedAt;
        copy.synced = copy.updatedAt === sentAt; // changed again while uploading: not in step yet
        storeCopy(copy);
        state = "account";
        if (copy.synced && !pushing.get(key)!.again) break;
        pushing.get(key)!.again = false;
        continue;
      }
      if (r.status === 409 && r.data.conflict && r.data.copy) {
        keepTheirs(r.data.copy);
        copy.syncedAt = r.data.updatedAt; // theirs is kept; ours now saves over the original
        continue;
      }
      break;
    }
  } finally {
    pushing.delete(key);
  }
  return state;
}

function mergeCopies(rows: { copy: LessonCopy; updatedAt: number }[]) {
  const local = new Map(allCopies().map((c) => [keyOf(c), c]));
  for (const { copy: theirs, updatedAt } of rows) {
    const mine = local.get(keyOf(theirs));
    if (!mine || (mine.synced !== false && mine.syncedAt !== updatedAt)) {
      // New to this device, or changed elsewhere while this device had nothing new: take theirs.
      storeCopy({ ...theirs, syncedAt: updatedAt, synced: true });
    } else if (mine.syncedAt !== updatedAt) {
      // Both changed it. Same text: just in step. Different: keep both.
      if (content(mine) !== content(theirs)) keepTheirs(theirs);
      storeCopy({ ...mine, syncedAt: updatedAt });
    }
    local.delete(keyOf(theirs));
  }
  // Copies the account doesn't have, or has an older version of, upload now.
  for (const c of allCopies()) if (c.synced === false || local.has(keyOf(c))) void pushCopy(c);
}

// ---------- progress ----------

/** Where the student is in a lesson; `completed` sticks on the server once set. */
export async function pushProgress(slug: string, positionMs: number, completed = false) {
  if (!(await signedInEmail())) return;
  await call(`/api/progress/${encodeURIComponent(slug)}`, { method: "PUT", body: { positionMs: Math.round(positionMs), completed } });
}

function mergeProgress(rows: { slug: string; positionMs: number; completed: boolean }[]) {
  const done = new Set(doneLessons());
  for (const r of rows) {
    if (r.completed) markDone(r.slug);
    else if (r.positionMs > 0 && !savedPosition(r.slug) && !done.has(r.slug)) savePosition(r.slug, r.positionMs);
  }
  const finishedThere = new Set(rows.filter((r) => r.completed).map((r) => r.slug));
  for (const slug of done) if (!finishedThere.has(slug)) void pushProgress(slug, 0, true);
}

/** Bring this browser and the account into step. Does nothing when signed out. */
export async function syncAll(): Promise<boolean> {
  if (!(await signedInEmail())) return false;
  const [copies, progress] = await Promise.all([
    call<{ copy: LessonCopy; updatedAt: number }[]>("/api/copies"),
    call<{ slug: string; positionMs: number; completed: boolean }[]>("/api/progress"),
  ]);
  if (copies.ok && Array.isArray(copies.data)) mergeCopies(copies.data);
  if (progress.ok && Array.isArray(progress.data)) mergeProgress(progress.data);
  return copies.ok && progress.ok;
}
