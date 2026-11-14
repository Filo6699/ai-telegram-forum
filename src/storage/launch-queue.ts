/**
 * Launches queued by other programs on this machine, one JSON file each.
 *
 * Files are the whole protocol: a writer renames a finished file into the
 * queue, so the bot never reads half of one, and the queue survives a bot that
 * is down — it starts whatever piled up once it's back. Access control is the
 * folder's own permissions.
 *
 *   <id>.json    waiting
 *   <id>.taken   claimed by the bot, topic not created yet
 *   failed/      rejected, with `<id>.error` beside the request
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface QueuedLaunch {
  id: string;
  /** Raw file contents; the caller parses and validates. */
  text: string;
}

const WAITING = ".json";
const TAKEN = ".taken";

/** Add a request to the queue; returns its id. Ids sort in queue order. */
export function enqueueLaunch(dir: string, request: unknown): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const tmp = join(dir, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(request, null, 2), { mode: 0o600 });
  renameSync(tmp, join(dir, id + WAITING));
  return id;
}

const ids = (dir: string, suffix: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix) && !name.startsWith("."))
      .map((name) => name.slice(0, -suffix.length))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
};

/**
 * A claimed request whose topic never got created belongs back in the queue:
 * the bot stopped between the two. Run once at startup, before claiming.
 */
export function requeueTaken(dir: string): string[] {
  const back = ids(dir, TAKEN);
  for (const id of back) releaseLaunch(dir, id);
  return back;
}

/** Claim every waiting request, oldest first. The rename makes each claim exclusive. */
export function claimLaunches(dir: string): QueuedLaunch[] {
  const claimed: QueuedLaunch[] = [];
  for (const id of ids(dir, WAITING)) {
    const taken = join(dir, id + TAKEN);
    try {
      renameSync(join(dir, id + WAITING), taken);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    claimed.push({ id, text: readFileSync(taken, "utf8") });
  }
  return claimed;
}

/** Put a claimed request back for a later attempt. */
export function releaseLaunch(dir: string, id: string): void {
  renameSync(join(dir, id + TAKEN), join(dir, id + WAITING));
}

/** The topic exists: the request is done with. */
export function finishLaunch(dir: string, id: string): void {
  rmSync(join(dir, id + TAKEN), { force: true });
}

/** Keep a rejected request with its reason, out of the queue. */
export function failLaunch(dir: string, id: string, reason: string): void {
  const failed = join(dir, "failed");
  mkdirSync(failed, { recursive: true, mode: 0o700 });
  writeFileSync(join(failed, `${id}.error`), reason + "\n", { mode: 0o600 });
  renameSync(join(dir, id + TAKEN), join(failed, id + WAITING));
}
