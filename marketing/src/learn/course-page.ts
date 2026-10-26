// Fills in the course page from what this browser remembers: finished lessons, where the
// student stopped, and their copies.
import { formatTime } from "../web/lesson.ts";
import { copiesOf } from "./copies.ts";
import { doneLessons, savedPosition } from "./progress.ts";

export function paintCourse() {
  const rows = [...document.querySelectorAll<HTMLElement>(".cp-row")];
  const done = doneLessons();
  const doneCount = rows.filter((r) => done.includes(r.dataset.slug!)).length;
  // Up next: a lesson the student is partway through, else the first one not finished.
  const started = rows.find((r) => !done.includes(r.dataset.slug!) && savedPosition(r.dataset.slug!) > 0);
  const next = started ?? rows.find((r) => !done.includes(r.dataset.slug!));

  rows.forEach((row, i) => {
    const slug = row.dataset.slug!;
    const isDone = done.includes(slug);
    const isNext = row === next;
    const at = savedPosition(slug);
    row.classList.toggle("done", isDone);
    row.classList.toggle("next", isNext);
    row.querySelector(".cp-state")!.textContent = isNext ? (at ? "In progress" : "Up next") : "";
    row.querySelector(".cp-row-where")!.textContent = isNext && at ? ` · stopped at ${formatTime(at)}` : "";
    row.querySelector(".cp-mark")!.setAttribute("aria-label", isDone ? "Done" : isNext ? "Up next" : `Lesson ${i + 1}`);

    const start = row.querySelector<HTMLAnchorElement>(".cp-start")!;
    start.hidden = !isNext;
    start.querySelector(".cp-start-label")!.textContent = at ? "Continue" : "Start";
    start.setAttribute("aria-label", `${at ? "Continue" : "Start"} ${row.dataset.title}`);

    // The copy the student worked on last; the lesson page opens it from ?copy=<moment>.
    const copies = copiesOf(slug).sort((a, b) => b.updatedAt - a.updatedAt);
    const link = row.querySelector<HTMLAnchorElement>(".cp-copy")!;
    link.hidden = !copies.length;
    if (copies.length) {
      link.href = `/learn/${slug}?copy=${copies[0].originMs}`;
      link.querySelector(".cp-copy-label")!.textContent = copies.length > 1 ? `Your copies · ${copies.length}` : "Your copy";
      link.setAttribute("aria-label", `Your copy of ${row.dataset.title}${copies.length > 1 ? ` (latest of ${copies.length})` : ""}`);
    }
  });

  const cta = document.getElementById("cp-cta") as HTMLAnchorElement;
  const label = document.getElementById("cp-cta-label")!;
  if (next) {
    const n = rows.indexOf(next) + 1;
    cta.href = `/learn/${next.dataset.slug}`;
    label.textContent = savedPosition(next.dataset.slug!) ? `Continue lesson ${n}` : doneCount ? `Continue with lesson ${n}` : "Start the course";
  } else {
    label.textContent = "Watch lesson 1 again";
  }
  document.getElementById("cp-done-count")!.textContent = !doneCount
    ? ""
    : doneCount === rows.length
      ? "You've finished every lesson"
      : `${doneCount} of ${rows.length} done`;
}
