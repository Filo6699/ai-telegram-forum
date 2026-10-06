import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitLegacyEnv } from "../config/migrate.ts";

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) throw new Error("Usage: npm run migrate-config -- [--dry-run]");
  const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
  const configPath = fileURLToPath(new URL("../../config.json", import.meta.url));
  if (existsSync(configPath)) throw new Error("config.json already exists; refusing to overwrite it");
  const { settings, envText } = splitLegacyEnv(readFileSync(envPath, "utf8"));
  if (args.includes("--dry-run")) {
    console.log("Validated: portable settings can move to config.json; .env will keep the six local values.");
    return;
  }
  // Write settings first: a failed .env write must never discard the old settings.
  writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const temporaryEnv = `${envPath}.migrate-${process.pid}`;
  try {
    writeFileSync(temporaryEnv, envText, { flag: "wx", mode: statSync(envPath).mode & 0o777 });
    renameSync(temporaryEnv, envPath);
  } finally {
    rmSync(temporaryEnv, { force: true });
  }
  console.log("Moved portable settings to config.json. .env contains only the six local values.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Configuration migration failed");
  process.exitCode = 1;
}
