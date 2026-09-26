#!/usr/bin/env node
/** One systemd timer tick: show charge used on the watchdog bot's profile photo. */
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = fileURLToPath(new URL("../", import.meta.url));
dotenv.config({ path: join(root, ".env") });

export function roundToFive(value) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Invalid battery capacity: ${value}`);
  }
  return Math.round(value / 5) * 5;
}

export function invertedPercent(batteryPercent) {
  return 100 - roundToFive(batteryPercent);
}

async function batteryCapacity() {
  let path = process.env.BATTERY_CAPACITY_PATH;
  if (!path) {
    const base = "/sys/class/power_supply";
    const entries = await readdir(base);
    const batteries = [];
    for (const entry of entries) {
      if ((await readFile(join(base, entry, "type"), "utf8").catch(() => "")).trim() === "Battery") {
        batteries.push(join(base, entry, "capacity"));
      }
    }
    if (batteries.length !== 1) {
      throw new Error(`Expected one battery, found ${batteries.length}; set BATTERY_CAPACITY_PATH`);
    }
    path = batteries[0];
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid capacity in ${path}`);
  return Number(value);
}

async function watchBotToken() {
  const path = process.env.WATCH_BOT_TOKEN_FILE || join(homedir(), "ailillu-watch/config/bot.env");
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const line = lines.find((value) => value.startsWith("TELEGRAM_BOT_TOKEN="));
  const token = line?.slice("TELEGRAM_BOT_TOKEN=".length).trim().replace(/^['"]|['"]$/g, "");
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`TELEGRAM_BOT_TOKEN missing or invalid in ${path}`);
  }
  return token;
}

async function main() {
  const token = await watchBotToken();
  const botId = token.split(":", 1)[0];

  const percent = await batteryCapacity();
  const rounded = roundToFive(percent);
  const inverted = invertedPercent(percent);
  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "ai-telegram-forum");
  const stateFile = join(stateDir, "watchbot-battery-avatar.json");
  const name = `${String(inverted).padStart(3, "0")}.jpg`;
  const photo = await readFile(join(root, "assets/battery-avatar", name));
  const imageHash = createHash("sha256").update(photo).digest("hex");
  const previous = await readFile(stateFile, "utf8").then(JSON.parse).catch(() => null);
  if (previous?.botId === botId && previous?.imageHash === imageHash) {
    console.log(`Battery ${percent}% → ${rounded}%: avatar already current`);
    return;
  }

  const meResponse = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(20_000),
  });
  const me = await meResponse.json();
  if (!me.ok || me.result?.username !== "claude_filo_watch_bot") {
    throw new Error("The token does not belong to @claude_filo_watch_bot");
  }

  const form = new FormData();
  form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
  form.append("avatar", new Blob([photo], { type: "image/jpeg" }), name);
  const response = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram setMyProfilePhoto failed: ${result.description ?? response.status}`);

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ botId, rounded, inverted, imageHash }) + "\n", { mode: 0o600 });
  await rename(temporary, stateFile);
  console.log(`Battery ${percent}% → ${rounded}%: uploaded ${name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
