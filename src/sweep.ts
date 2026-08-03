import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import { cfg } from "./config.ts";
import { deleteTopic, listStale, setStatus } from "./db.ts";

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Claude Code stores session transcripts under
 *   ~/.claude/projects/<cwd-with-slashes-turned-to-dashes>/
 * Remove that folder when a topic is deleted so disk doesn't grow forever.
 */
async function removeTranscripts(cwd: string): Promise<void> {
  const encoded = cwd.replace(/\//g, "-");
  const dir = join(homedir(), ".claude", "projects", encoded);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[sweep] could not remove ${dir}:`, String(err));
  }
}

async function sweepOnce(bot: Bot): Promise<void> {
  const { toClose, toDelete } = listStale(cfg.closeAfterMs, cfg.deleteAfterMs);

  for (const t of toClose) {
    try {
      await bot.api.closeForumTopic(cfg.chatId, t.thread_id);
      setStatus(t.thread_id, "closed");
      console.log(`[sweep] closed idle topic ${t.thread_id} (${t.title})`);
    } catch (err) {
      console.warn(`[sweep] close failed for ${t.thread_id}:`, String(err));
    }
  }

  for (const t of toDelete) {
    try {
      await bot.api.deleteForumTopic(cfg.chatId, t.thread_id);
      await removeTranscripts(t.cwd);
      deleteTopic(t.thread_id);
      console.log(`[sweep] deleted stale topic ${t.thread_id} (${t.title})`);
    } catch (err) {
      console.warn(`[sweep] delete failed for ${t.thread_id}:`, String(err));
    }
  }
}

export function startSweep(bot: Bot): void {
  setInterval(() => void sweepOnce(bot), SWEEP_INTERVAL_MS);
}
