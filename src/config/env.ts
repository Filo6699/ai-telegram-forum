import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./settings.ts";
import { buildConfig } from "./runtime.ts";

// Both entry points use the checkout's files, even when invoked from a project.
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });
const settings = loadSettings(fileURLToPath(new URL("../../config.json", import.meta.url)));

export const cfg = buildConfig(settings, process.env);
