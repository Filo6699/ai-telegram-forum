import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrammyError, HttpError, type Bot } from "grammy";
import { cfg } from "./config.ts";
import { deleteTopic, listStale, type Topic } from "./db.ts";
import { endSession } from "./session.ts";

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

/** The topic no longer exists on Telegram — usually deleted by hand. */
function isTopicGone(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toUpperCase();
  return (
    d.includes("TOPIC_ID_INVALID") ||
    d.includes("TOPIC_DELETED") ||
    d.includes("MESSAGE THREAD NOT FOUND") ||
    d.includes("CHAT NOT FOUND")
  );
}

/** Telegram is unreachable — no point hammering the rest of the sweep. */
function isNetworkDown(err: unknown): boolean {
  return err instanceof HttpError;
}

/** Drop a topic we can no longer reach: transcripts + DB row. */
async function forget(t: Topic, reason: string): Promise<void> {
  endSession(t.thread_id);
  await removeTranscripts(t.cwd);
  deleteTopic(t.thread_id);
  console.log(`[sweep] forgot topic ${t.thread_id} (${t.title}) — ${reason}`);
}

async function sweepOnce(bot: Bot): Promise<void> {
  // Only deletion: closing a topic pushes a notification to the user, which is
  // pure noise for a topic they've already stopped using.
  for (const t of listStale(cfg.deleteAfterMs)) {
    try {
      await bot.api.deleteForumTopic(cfg.chatId, t.thread_id);
      endSession(t.thread_id);
      await removeTranscripts(t.cwd);
      deleteTopic(t.thread_id);
      console.log(`[sweep] deleted stale topic ${t.thread_id} (${t.title})`);
    } catch (err) {
      if (isTopicGone(err)) {
        await forget(t, "already deleted");
      } else if (isNetworkDown(err)) {
        console.warn("[sweep] Telegram unreachable, retrying next sweep");
        return;
      } else {
        console.warn(`[sweep] delete failed for ${t.thread_id}:`, String(err));
      }
    }
  }
}

export function startSweep(bot: Bot): void {
  // Run once at boot: a bot restarting more often than SWEEP_INTERVAL_MS would
  // otherwise never sweep at all.
  void sweepOnce(bot);
  setInterval(() => void sweepOnce(bot), SWEEP_INTERVAL_MS);
}
