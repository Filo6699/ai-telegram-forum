/**
 * Queue a new session from outside Telegram: a cron job, a script, another bot.
 *
 *   npm run --silent launch -- --prompt-file <file|-> [--cwd <dir|@alias>] [--title <text>]
 *                             [--preset <name> | --provider <p> --model <id> --effort <level>
 *                              --service-tier <default|fast>]
 *
 * The request is checked against this checkout's config now, so a typo fails
 * here rather than in the launcher, and written to the launch queue. The bot
 * opens the topic within seconds, or once it's next up. Prints the request id.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cfg } from "../config/env.ts";
import { brokerPid } from "../app/heartbeat.ts";
import { resolveLaunchRequest, type LaunchRequest } from "../sessions/launch-request.ts";
import { enqueueLaunch } from "../storage/launch-queue.ts";

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    cwd: { type: "string" },
    title: { type: "string" },
    preset: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    "service-tier": { type: "string" },
    "dry-run": { type: "boolean" },
  },
  strict: true,
});

function fail(message: string): never {
  console.error(`launch: ${message}`);
  process.exit(1);
}

const file = values["prompt-file"];
if ((values.prompt === undefined) === (file === undefined)) fail("give exactly one of --prompt or --prompt-file");
const prompt = values.prompt ?? readFileSync(file === "-" ? 0 : file!, "utf8");

const request: LaunchRequest = {
  prompt,
  ...(values.cwd !== undefined && { cwd: values.cwd }),
  ...(values.title !== undefined && { title: values.title }),
  ...(values.preset !== undefined && { preset: values.preset }),
  ...(values.provider !== undefined && { provider: values.provider }),
  ...(values.model !== undefined && { model: values.model }),
  ...(values.effort !== undefined && { effort: values.effort }),
  ...(values["service-tier"] !== undefined && { serviceTier: values["service-tier"] as "default" | "fast" }),
};

let resolved;
try {
  resolved = resolveLaunchRequest(request);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const { provider, settings, preset } = resolved.choice;
const summary = `«${resolved.title}» in ${resolved.cwd}, ${provider} ` +
  (preset ? `preset ${preset}` : `model ${settings.model ?? "default"}, effort ${settings.effort ?? "default"}`);

if (values["dry-run"]) {
  console.error(`launch: would queue ${summary}`);
} else {
  const id = enqueueLaunch(cfg.launchQueuePath, request);
  console.error(`launch: queued ${summary}`);
  if (!brokerPid()) console.error("launch: the bot isn't running; it will start this once it is");
  console.log(id);
}
