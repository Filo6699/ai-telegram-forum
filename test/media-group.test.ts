import assert from "node:assert/strict";
import test from "node:test";
import { MediaGroupCollector } from "../src/media-group.ts";

test("collects album updates in order and flushes once", async () => {
  let resolve!: (items: number[]) => void;
  const flushed = new Promise<number[]>((done) => (resolve = done));
  const collector = new MediaGroupCollector<number>(10, resolve);

  collector.add("album", 1);
  collector.add("album", 2);

  assert.deepEqual(await flushed, [1, 2]);
  collector.flush("album");
});

test("flushes a complete Telegram album immediately", () => {
  const groups: number[][] = [];
  const collector = new MediaGroupCollector<number>(10_000, (items) => groups.push(items), 3);

  collector.add("album", 1);
  collector.add("album", 2);
  collector.add("album", 3);

  assert.deepEqual(groups, [[1, 2, 3]]);
});
