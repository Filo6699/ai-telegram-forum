import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { codexAppThreadParams } from "../src/providers/codex/options.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("integration installer targets this checkout when invoked from another project", () => {
  const project = mkdtempSync(join(tmpdir(), "tg-install-"));
  try {
    execFileSync(process.execPath, [
      "--import", import.meta.resolve("tsx"),
      join(repo, "src/cli/install-command.ts"), "--project",
    ], { cwd: project });
    for (const file of [".claude/commands/telegramify.md", ".agents/skills/telegramify/SKILL.md"]) {
      const command = readFileSync(join(project, file), "utf8");
      assert.ok(command.includes(`npm --prefix ${repo.replace(/\/$/, "")} run`));
      assert.ok(command.includes("telegramify -- --provider"));
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Codex's configured Telegram MCP process starts and accepts send calls", async () => {
  const params = codexAppThreadParams({
    threadId: 123, cwd: tmpdir(), effort: null, model: null, serviceTier: null,
  });
  const config = params.config as {
    mcp_servers: { tg: { command: string; args: string[]; cwd: string } };
  };
  const transport = new StdioClientTransport(config.mcp_servers.tg);
  const client = new Client({ name: "entrypoint-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["send"]);
    const result = await client.callTool({ name: "send", arguments: { text: "test" } });
    assert.deepEqual(result.content, [{ type: "text", text: "accepted" }]);
  } finally {
    await client.close();
  }
});
