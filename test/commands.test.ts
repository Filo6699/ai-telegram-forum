import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { botCommands, parseCommand } from "../src/telegram/commands.ts";

const parse = (text: string) => parseCommand(text, "ThisBot");

test("every menu command and the agent alias keep their exact meaning", () => {
  for (const { command } of botCommands) {
    assert.deepEqual(parse(`/${command}`), { kind: "command", command: `/${command}`, args: "" });
  }
  assert.deepEqual(parse("/agent codex"), { kind: "command", command: "/provider", args: "codex" });
});

test("corrects substitutions, insertions, deletions, and adjacent swaps", () => {
  for (const [input, command] of [
    ["/modee", "/model"],
    ["/moddel", "/model"],
    ["/modl", "/model"],
    ["/usaeg", "/usage"],
    ["/uesage", "/usage"],
    ["/stpo", "/stop"],
  ]) {
    assert.deepEqual(parse(input!), { kind: "command", command, args: "" });
  }
});

test("completes prefixes even when a different short command has fewer edits", () => {
  for (const [input, command] of [
    ["/usa", "/usage"],
    ["/prog", "/progress"],
    ["/too", "/toolcalls"],
    ["/e", "/effort"],
    ["/ag", "/provider"],
    ["/pro", "/provider"], // Equal length completions use menu order.
  ]) {
    assert.deepEqual(parse(input!), { kind: "command", command, args: "" });
  }
});

test("preserves arguments and bot addressing for fuzzy matches and side questions", () => {
  assert.deepEqual(parse("  /MODEE@thisbot\tsonnet  "), {
    kind: "command", command: "/model", args: "sonnet",
  });
  assert.deepEqual(parse("/bwt@THISBOT  First line\nSecond line /usage"), {
    kind: "command", command: "/btw", args: "First line\nSecond line /usage",
  });
  assert.deepEqual(parse("/effrot high"), { kind: "command", command: "/effort", args: "high" });
  assert.deepEqual(parse("/progres off"), { kind: "command", command: "/progress", args: "off" });
});

test("every nonempty slash name matches without a distance threshold", () => {
  const commands = botCommands.map(({ command }) => `/${command}`);
  for (const input of ["/zzzzzzzzzzzzzzzzzzzz", "/???", "/команда", "/srv/app explain this"]) {
    const result = parse(input);
    assert.equal(result.kind, "command");
    if (result.kind === "command") assert.ok(commands.includes(result.command));
  }
  // All menu commands have the same distance from this name: menu order wins.
  assert.deepEqual(parse("/zzzzzzzzzzzzzzzzzzzz"), { kind: "command", command: "/usage", args: "" });
});

test("bare slashes and commands for another bot are consumed without a prompt", () => {
  for (const input of ["/", "/   ", "/@ThisBot", "/usage@OtherBot", " /modee@OtherBot sonnet"]) {
    assert.deepEqual(parse(input), { kind: "ignored" });
  }
});

test("ordinary messages, alias prefixes, and slashes inside a prompt reach the agent", () => {
  for (const input of ["", "hello", "@myrepo fix tests", "explain /usage", "look at\n/srv/app"]) {
    assert.deepEqual(parse(input), { kind: "prompt" });
  }
});

test("launcher paths pass through for cwd resolution, including media captions", () => {
  for (const path of ["/srv/app", "/new/project/", "/srv/user@host/app", "/", tmpdir()]) {
    const input = `  ${path} explain this\nwith details  `;
    assert.deepEqual(parseCommand(input, "ThisBot", true), { kind: "prompt" });
    assert.notEqual(parse(input).kind, "prompt");
  }
});

test("launcher commands still match typos and consume commands for other bots", () => {
  for (const input of ["/modee sonnet", "/usa", "/usaeg", "/usage@OtherBot", "/", "/zzzzzzzz high"]) {
    assert.deepEqual(parseCommand(input, "ThisBot", true), parse(input));
  }
});
