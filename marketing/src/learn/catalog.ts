// The playlists and their lessons, read at build time from src/learn/playlists.json and the
// lesson files in public/lessons/. A lesson can sit in more than one playlist; its page belongs
// to the first one that lists it.
import { readFileSync } from "node:fs";
import data from "./playlists.json";
import { formatTime } from "../web/lesson.ts";

export interface LessonInfo {
  slug: string;
  title: string;
  kind: "Code" | "Web page";
  length: string;
  durationMs: number;
}

export interface Playlist {
  slug: string;
  title: string;
  intro: string;
  lessons: LessonInfo[];
  durationMs: number;
}

export const teacher = data.teacher as { name: string; photo: string | null };

const cache = new Map<string, LessonInfo>();
export function lessonInfo(slug: string): LessonInfo {
  let info = cache.get(slug);
  if (!info) {
    // Relative to the project root (Astro's cwd): import.meta.url points into dist/ once bundled.
    const l = JSON.parse(readFileSync(`public/lessons/${slug}.json`, "utf8"));
    info = { slug, title: l.title, kind: l.kind === "playground" ? "Web page" : "Code", length: formatTime(l.durationMs), durationMs: l.durationMs };
    cache.set(slug, info);
  }
  return info;
}

export const playlists: Playlist[] = data.playlists.map((p) => {
  const lessons = p.lessons.map(lessonInfo);
  return { ...p, lessons, durationMs: lessons.reduce((sum, l) => sum + l.durationMs, 0) };
});

/** Every lesson once, in playlist order. */
export const allLessons: LessonInfo[] = [...new Map(playlists.flatMap((p) => p.lessons).map((l) => [l.slug, l])).values()];

/** The playlist a lesson's page belongs to. */
export const homePlaylist = (slug: string) => playlists.find((p) => p.lessons.some((l) => l.slug === slug))!;

export const playlistUrl = (p: { slug: string }) => `/learn/list/${p.slug}/`;

/** "12 min", "1 h 5 min": a length for people, not a timestamp. */
export function minutes(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** What the overview pages need in the browser, as JSON for a <script type="application/json">. */
export function catalogJson() {
  const data: CatalogData = {
    playlists: playlists.map((p) => ({ slug: p.slug, title: p.title, lessons: p.lessons.map((l) => l.slug) })),
    lessons: Object.fromEntries(allLessons.map((l) => [l.slug, { title: l.title, durationMs: l.durationMs, home: homePlaylist(l.slug).slug }])),
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export interface CatalogData {
  playlists: { slug: string; title: string; lessons: string[] }[];
  lessons: Record<string, { title: string; durationMs: number; home: string }>;
}
