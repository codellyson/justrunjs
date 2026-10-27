import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
} as Storage;

const { listState, markDone, markLast, lastLesson, savePosition } = await import("../src/learn/progress.ts");

test("up next is the lesson partway through, else the first not done, else none", () => {
  store.clear();
  const list = ["a", "b", "c"];
  assert.deepEqual({ ...listState(list), done: undefined }, { doneCount: 0, next: "a", done: undefined });

  markDone("a");
  savePosition("c", 5000);
  assert.equal(listState(list).next, "c");
  assert.equal(listState(list).doneCount, 1);

  markDone("b");
  markDone("c");
  assert.equal(listState(list).next, null);
  assert.equal(listState(list).doneCount, 3);
});

test("the last lesson is remembered", () => {
  store.clear();
  assert.equal(lastLesson(), null);
  markLast("b");
  assert.equal(lastLesson(), "b");
});
