import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cfg } from "../src/config/env.ts";
import { existingFolders, isDirectory } from "../src/sessions/cwd.ts";

test("a launch can only fall back to project folders that exist, each once", () => {
  const root = mkdtempSync(join(tmpdir(), "tg-cwd-"));
  const missing = join(root, "gone");
  const saved = { defaultCwd: cfg.defaultCwd, projects: cfg.projects };
  Object.assign(cfg, {
    defaultCwd: root,
    projects: { here: `${root}/`, gone: missing, tmp: tmpdir() },
  });
  try {
    assert.equal(isDirectory(missing), false);
    assert.deepEqual(existingFolders(), [
      { name: "here", cwd: root },
      { name: "tmp", cwd: tmpdir() },
    ]);
  } finally {
    Object.assign(cfg, saved);
  }
});
