#!/usr/bin/env node
/** One systemd timer tick: read the laptop battery and upload only on change. */
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

async function main() {
  const token = process.env.BOT_TOKEN;
  const chatId = process.env.FORUM_CHAT_ID;
  if (!token || !/^-?\d+$/.test(chatId ?? "")) {
    throw new Error("BOT_TOKEN and FORUM_CHAT_ID are required in .env");
  }

  const percent = await batteryCapacity();
  const rounded = roundToFive(percent);
  const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "ai-telegram-forum");
  const stateFile = join(stateDir, "battery-avatar.json");
  const previous = await readFile(stateFile, "utf8").then(JSON.parse).catch(() => null);
  if (previous?.chatId === chatId && previous?.rounded === rounded) {
    console.log(`Battery ${percent}% → ${rounded}%: avatar already current`);
    return;
  }

  const name = `${String(rounded).padStart(3, "0")}.jpg`;
  const photo = await readFile(join(root, "assets/battery-avatar", name));
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([photo], { type: "image/jpeg" }), name);
  const response = await fetch(`https://api.telegram.org/bot${token}/setChatPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram setChatPhoto failed: ${result.description ?? response.status}`);

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ chatId, rounded }) + "\n", { mode: 0o600 });
  await rename(temporary, stateFile);
  console.log(`Battery ${percent}% → ${rounded}%: uploaded ${name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
