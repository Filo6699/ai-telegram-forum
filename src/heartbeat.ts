/**
 * Liveness marker for the broker process.
 *
 * Adopting a session only makes sense while the bot is up: the topic it creates
 * is answered by long polling, and nothing else. So the bot keeps a heartbeat
 * file warm and `/telegramify` refuses to run when it's cold — better a clear
 * error in the terminal than a topic that silently swallows messages.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cfg } from "./config.ts";

const BEAT_MS = 30_000;
/** A beat may be late (busy loop, suspended laptop) before we call it dead. */
const STALE_MS = BEAT_MS * 3;

function beat(): void {
  writeFileSync(cfg.pidPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
}

/** Start writing the heartbeat, and clear it on the way out. */
export function startHeartbeat(): void {
  mkdirSync(dirname(cfg.pidPath), { recursive: true });
  beat();
  const timer = setInterval(beat, BEAT_MS);
  // Don't hold the event loop open just for the heartbeat.
  timer.unref?.();

  const stop = (): void => {
    try {
      rmSync(cfg.pidPath, { force: true });
    } catch {
      // best effort — a stale file is caught by the freshness check anyway
    }
  };
  process.once("exit", stop);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      stop();
      process.exit(0);
    });
  }
}

/** The live broker's pid, or null if nothing is running. */
export function brokerPid(): number | null {
  let raw: { pid?: number; at?: number };
  let mtimeMs: number;
  try {
    mtimeMs = statSync(cfg.pidPath).mtimeMs;
    raw = JSON.parse(readFileSync(cfg.pidPath, "utf8"));
  } catch {
    return null;
  }
  if (Date.now() - Math.max(mtimeMs, raw.at ?? 0) > STALE_MS) return null;
  const pid = raw.pid;
  if (!pid) return null;
  try {
    // Signal 0 checks for existence without touching the process.
    process.kill(pid, 0);
  } catch {
    return null; // the file outlived its process
  }
  return pid;
}
