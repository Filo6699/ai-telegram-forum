import { cfg } from "../config/env.ts";
import { resolveLaunchRequest, type ResolvedLaunch } from "../sessions/launch-request.ts";
import { claimLaunches, failLaunch, finishLaunch, releaseLaunch, requeueTaken } from "../storage/launch-queue.ts";

const POLL_MS = 3_000;
/** After a launch fails to open (Telegram unreachable, most likely). */
const RETRY_MS = 60_000;

/**
 * Start queued launches as they arrive. `open` creates the topic and returns
 * once it exists; the request file is dropped then, so a bot restart after
 * that point can't open the same topic twice. `report` tells the launcher
 * about a request it rejected or couldn't start yet.
 */
export function startLaunchQueue(
  open: (launch: ResolvedLaunch) => Promise<void>,
  report: (text: string) => Promise<void>,
): void {
  const dir = cfg.launchQueuePath;
  const back = requeueTaken(dir);
  if (back.length) console.warn(`[queue] requeued ${back.length} launch(es) the last run never opened`);

  let busy = false;
  let pausedUntil = 0;
  const reported = new Set<string>();
  const poll = async (): Promise<void> => {
    if (busy || Date.now() < pausedUntil) return;
    busy = true;
    try {
      for (const { id, text } of claimLaunches(dir)) {
        if (Date.now() < pausedUntil) {
          releaseLaunch(dir, id);
          continue;
        }
        let launch: ResolvedLaunch;
        try {
          launch = resolveLaunchRequest(JSON.parse(text));
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.warn(`[queue] ${id} rejected: ${reason}`);
          failLaunch(dir, id, reason);
          await report(`❌ queued launch ${id} rejected: ${reason}`).catch(() => {});
          continue;
        }
        try {
          await open(launch);
          finishLaunch(dir, id);
          reported.delete(id);
          console.log(`[queue] ${id} started «${launch.title}» in ${launch.cwd}`);
        } catch (err) {
          // Usually Telegram being unreachable: keep the request and try again
          // in a minute, saying so once rather than on every attempt.
          console.error(`[queue] ${id} failed to open, retrying in ${RETRY_MS / 1000}s:`, err);
          releaseLaunch(dir, id);
          pausedUntil = Date.now() + RETRY_MS;
          if (!reported.has(id)) {
            reported.add(id);
            await report(`⚠️ queued launch «${launch.title}» couldn't start yet, retrying: ${String(err)}`)
              .catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error("[queue] poll failed:", err);
    } finally {
      busy = false;
    }
  };

  void poll();
  setInterval(() => void poll(), POLL_MS).unref?.();
}
