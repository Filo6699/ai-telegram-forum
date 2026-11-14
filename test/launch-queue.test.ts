import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLaunchRequest } from "../src/sessions/launch-request.ts";
import {
  claimLaunches,
  enqueueLaunch,
  failLaunch,
  finishLaunch,
  releaseLaunch,
  requeueTaken,
} from "../src/storage/launch-queue.ts";

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tg-queue-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("queued launches are claimed once, oldest first", () => withDir((dir) => {
  const first = enqueueLaunch(dir, { prompt: "one" });
  const second = enqueueLaunch(dir, { prompt: "two" });
  const claimed = claimLaunches(dir);
  assert.deepEqual(claimed.map((item) => item.id), [first, second].sort());
  assert.equal(JSON.parse(claimed.find((item) => item.id === first)!.text).prompt, "one");
  assert.deepEqual(claimLaunches(dir), []);
  finishLaunch(dir, first);
  finishLaunch(dir, second);
  assert.deepEqual(readdirSync(dir), []);
}));

test("a missing queue folder is an empty queue", () => withDir((dir) => {
  assert.deepEqual(claimLaunches(join(dir, "absent")), []);
  assert.deepEqual(requeueTaken(join(dir, "absent")), []);
}));

test("claims left by a stopped bot go back to the queue", () => withDir((dir) => {
  const id = enqueueLaunch(dir, { prompt: "again" });
  claimLaunches(dir);
  assert.deepEqual(requeueTaken(dir), [id]);
  assert.equal(claimLaunches(dir)[0]?.id, id);
  releaseLaunch(dir, id);
  assert.equal(claimLaunches(dir)[0]?.id, id);
}));

test("rejected launches keep their request and reason", () => withDir((dir) => {
  const id = enqueueLaunch(dir, { prompt: "bad" });
  claimLaunches(dir);
  failLaunch(dir, id, "no preset named X");
  assert.equal(readFileSync(join(dir, "failed", `${id}.error`), "utf8"), "no preset named X\n");
  assert.ok(existsSync(join(dir, "failed", `${id}.json`)));
  assert.deepEqual(claimLaunches(dir), []);
}));

test("launch requests name a real folder and one way to pick settings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tg-launch-cwd-"));
  try {
    const launch = resolveLaunchRequest({
      prompt: "check the build\nin detail",
      cwd,
      model: "claude-haiku-5-5",
      effort: "low",
    });
    assert.equal(launch.cwd, cwd);
    assert.equal(launch.choice.provider, "claude");
    assert.equal(launch.choice.settings.model, "claude-haiku-5-5");
    assert.equal(launch.choice.settings.effort, "low");
    assert.match(launch.title, /check the build$/);
    assert.equal(resolveLaunchRequest({ prompt: "x", cwd, title: "⏰ weekly" }).title, "⏰ weekly");

    assert.throws(() => resolveLaunchRequest({ prompt: "  " }), /prompt/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd: "relative/dir" }), /absolute path/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd: "@no-such-alias" }), /unknown project alias/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd: join(cwd, "missing") }), /doesn't exist/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd, preset: "Any", model: "claude-opus-5-5" }), /either preset/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd, preset: "no-such-preset" }), /no preset/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd, model: "claude-opus-5-5", effort: "huge" }), /effort level/);
    assert.throws(() => resolveLaunchRequest({ prompt: "x", cwd, unknown: 1 }), /unknown|Unrecognized/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
