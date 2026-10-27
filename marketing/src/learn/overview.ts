// Fills in the playlists page and the progress page from what this browser remembers: finished
// lessons, where the student stopped, the lesson they were last in, and their copies.
import { formatTime } from "../web/lesson.ts";
import type { CatalogData } from "./catalog.ts";
import { allCopies } from "./copies.ts";
import { doneLessons, lastLesson, listState, savedPosition } from "./progress.ts";

const catalog = (): CatalogData => JSON.parse(document.getElementById("catalog")!.textContent!);

const percent = (part: number, whole: number) => `${whole ? Math.min(100, Math.round((part / whole) * 100)) : 0}%`;

/** Each .pl-card: a bar and count of lessons done, and a button into the lesson that's up next. */
function paintCards(data: CatalogData) {
  for (const card of document.querySelectorAll<HTMLElement>(".pl-card")) {
    const playlist = data.playlists.find((p) => p.slug === card.dataset.playlist);
    if (!playlist) continue;
    const { doneCount, next } = listState(playlist.lessons);
    const total = playlist.lessons.length;
    card.querySelector<HTMLElement>(".pl-fill")!.style.width = percent(doneCount, total);
    card.querySelector(".pl-card-count")!.textContent = !doneCount ? "" : doneCount === total ? "Finished" : `${doneCount} of ${total} done`;
    card.classList.toggle("done", doneCount === total);

    const go = card.querySelector<HTMLAnchorElement>(".pl-card-start")!;
    const target = next ?? playlist.lessons[0];
    const label = !next ? "Watch again" : doneCount || savedPosition(next) ? "Continue" : "Start";
    go.href = `/learn/${target}`;
    go.querySelector(".pl-card-start-label")!.textContent = label;
    go.setAttribute("aria-label", `${label}: ${data.lessons[target].title}`);
  }
}

export function paintIndex() {
  const data = catalog();
  paintCards(data);

  // The lesson they were last in; once that's finished, the next one in its playlist.
  const box = document.getElementById("pl-continue")!;
  const last = lastLesson();
  const lesson = last ? data.lessons[last] : undefined;
  if (!last || !lesson) return void (box.hidden = true);
  const playlist = data.playlists.find((p) => p.slug === lesson.home)!;
  const target = doneLessons().includes(last) ? listState(playlist.lessons).next : last;
  if (!target) return void (box.hidden = true);

  const at = savedPosition(target);
  const info = data.lessons[target];
  const title = document.getElementById("pl-continue-title") as HTMLAnchorElement;
  const go = document.getElementById("pl-continue-go") as HTMLAnchorElement;
  title.textContent = info.title;
  title.href = go.href = `/learn/${target}`;
  document.getElementById("pl-continue-meta")!.textContent = at
    ? `${playlist.title} · stopped at ${formatTime(at)} of ${formatTime(info.durationMs)}`
    : `${playlist.title} · up next`;
  document.getElementById("pl-continue-fill")!.style.width = percent(at, info.durationMs);
  document.getElementById("pl-continue-go-label")!.textContent = at ? "Continue" : "Start";
  box.hidden = false;
}

export function paintProgress() {
  const data = catalog();
  paintCards(data);

  const slugs = Object.keys(data.lessons);
  const done = doneLessons();
  const finished = slugs.filter((s) => done.includes(s));
  const watchedMs = slugs.reduce((sum, s) => sum + (done.includes(s) ? data.lessons[s].durationMs : savedPosition(s)), 0);
  const copies = allCopies()
    .filter((c) => data.lessons[c.slug])
    .sort((a, b) => b.updatedAt - a.updatedAt);

  document.getElementById("pg-finished")!.textContent = `${finished.length} of ${slugs.length}`;
  document.getElementById("pg-watched")!.textContent = watchedMs ? formatTime(watchedMs) : "0:00";
  document.getElementById("pg-copies-count")!.textContent = String(copies.length);

  const list = document.getElementById("pg-copies")!;
  document.getElementById("pg-no-copies")!.hidden = copies.length > 0;
  list.replaceChildren(
    ...copies.map((c) => {
      const li = document.createElement("li");
      li.className = "pg-copy";
      const a = document.createElement("a");
      a.href = `/learn/${c.slug}?copy=${c.originMs}`;
      a.textContent = data.lessons[c.slug].title;
      const meta = document.createElement("span");
      meta.className = "cp-row-meta";
      meta.textContent = `From ${formatTime(c.originMs)} in the lesson · changed ${new Date(c.updatedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
      li.append(a, meta);
      return li;
    }),
  );
}
