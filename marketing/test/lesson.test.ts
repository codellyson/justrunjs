import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { replay, checkpoints, seek, type Lesson } from "../src/web/lesson.ts";

// 300 random edits to the html slot, switching to css halfway; snapshots[t - 1] is html after time t.
function randomLesson() {
  let state = EditorState.create({ doc: "<h1>Hi</h1>\n" });
  const lesson: Lesson = {
    version: 1, title: "t", audio: "a.m4a", durationMs: 300, kind: "playground", language: "javascript",
    active: "html", files: [{ id: "html", content: state.doc.toString() }, { id: "css", content: "" }], events: [],
  };
  const snapshots: string[] = [];
  let seed = 7;
  const rand = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
  for (let t = 1; t <= 300; t++) {
    const len = state.doc.length;
    const from = rand(len + 1);
    const insert = ["x", "\n", "😀", "", "ab\ncd"][rand(5)];
    const tr = state.update({ changes: { from, to: Math.min(len, from + rand(4)), insert } });
    lesson.events.push({ t, type: "change", file: "html", changes: tr.changes.toJSON() });
    state = tr.state;
    snapshots.push(state.doc.toString());
  }
  lesson.events.splice(150, 0, { t: 150, type: "open", file: "css" });
  return { lesson, snapshots };
}

test("replay rebuilds every slot at any time", () => {
  const { lesson, snapshots } = randomLesson();
  for (const t of [1, 77, 150, 300]) assert.equal(replay(lesson, t).docs.get("html")!.toString(), snapshots[t - 1]);
  assert.equal(replay(lesson, 0).docs.get("html")!.toString(), lesson.files[0].content);
  assert.equal(replay(lesson, 149).active, "html");
  assert.equal(replay(lesson, 150).active, "css");
});

test("seeking from checkpoints matches replay from the start", () => {
  const { lesson } = randomLesson();
  const marks = checkpoints(lesson, 25);
  for (const t of [300, 0, 150, 149, 151, 12, 299, 1, 200, 75, 76, 300, 5]) {
    const a = seek(lesson, marks, t);
    const b = replay(lesson, t);
    assert.equal(a.docs.get("html")!.toString(), b.docs.get("html")!.toString(), `t=${t}`);
    assert.equal(a.next, b.next);
    assert.equal(a.active, b.active);
  }
  assert.equal(marks[0].docs.get("html")!.toString(), lesson.files[0].content);
});

test("replay refuses a change that does not fit", () => {
  const { lesson } = randomLesson();
  lesson.events = [{ t: 1, type: "change", file: "html", changes: [500, [0, "z"]] }];
  assert.throws(() => replay(lesson));
});
