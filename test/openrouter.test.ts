import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeOpenRouterModel } from "../src/openrouter-model.ts";
import { openRouterModelPicker, parseOpenRouterPresets } from "../src/openrouter-config.ts";

test("OpenRouter model ids preserve slash and :free when copied from links", () => {
  assert.equal(normalizeOpenRouterModel("openrouter/free"), "openrouter/free");
  assert.equal(
    normalizeOpenRouterModel("https://openrouter.ai/models/deepseek/deepseek-v4-flash-0731:free?x=1"),
    "deepseek/deepseek-v4-flash-0731:free",
  );
  assert.equal(normalizeOpenRouterModel("not a model"), null);
});

test("OpenRouter presets keep optional request settings and short picker callbacks", () => {
  const presets = parseOpenRouterPresets(
    JSON.stringify({
      Free: { model: "openrouter/free" },
      DeepSeek: {
        model: "https://openrouter.ai/deepseek/deepseek-v4-flash-0731:free",
        temperature: 0.2,
        max_tokens: 4096,
        reasoning: { effort: "high" },
        provider: { allow_fallbacks: false },
        fallbacks: ["google/gemini-2.5-flash"],
      },
    }),
  );
  assert.equal(presets[1]?.model, "deepseek/deepseek-v4-flash-0731:free");
  assert.deepEqual(presets[1]?.fallbacks, ["google/gemini-2.5-flash"]);
  const picker = openRouterModelPicker(null, "openrouter/free", presets);
  assert.ok(picker.group.options.every((option) => option.value.length < 256));
  assert.equal(picker.selected("preset:1").settings.temperature, 0.2);
});

test("OpenRouter client retries 429 and never sends an empty-key request", async () => {
  process.env.BOT_TOKEN ??= "test-token";
  process.env.FORUM_CHAT_ID ??= "-100123";
  process.env.ALLOWED_USER_ID ??= "1";
  process.env.DEFAULT_CWD ??= process.cwd();
  process.env.PERMISSION ??= "bypass";
  process.env.OPENROUTER_API_KEY = "test-key";
  const historyRoot = await mkdtemp(join(tmpdir(), "openrouter-history-"));
  process.env.OPENROUTER_HISTORY_PATH = historyRoot;
  const { OpenRouterClient, openRouterUsage } = await import("../src/openrouter.ts");

  let calls = 0;
  const client = new OpenRouterClient("test-key", async (_url, init) => {
    calls++;
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
    return new Response(
      JSON.stringify({ model: "deepseek/deepseek-v4-flash-0731:free", usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0 }, choices: [{ message: { role: "assistant", content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const response = await client.complete({ model: "openrouter/free", messages: [] });
  assert.equal(calls, 2);
  assert.equal(response.model, "deepseek/deepseek-v4-flash-0731:free");
  assert.deepEqual(openRouterUsage(response), { inTokens: 3, outTokens: 2, costUsd: 0 });

  let emptyCalls = 0;
  const empty = new OpenRouterClient("", async () => {
    emptyCalls++;
    return new Response("should not run", { status: 200 });
  });
  await assert.rejects(() => empty.complete({ model: "openrouter/free", messages: [] }), /API_KEY is empty/);
  assert.equal(emptyCalls, 0);

  const rejected = new OpenRouterClient("bad-key", async () =>
    new Response(JSON.stringify({ error: { message: "invalid token" } }), { status: 401 }),
  );
  await assert.rejects(
    () => rejected.complete({ model: "openrouter/free", messages: [] }),
    /authorization failed.*API_KEY was rejected/,
  );
});

test("OpenRouter agent loop persists tool messages and resumes the same history", async () => {
  const originalFetch = globalThis.fetch;
  const chatBodies: any[] = [];
  const responses = [
    {
      model: "openrouter/free",
      usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0 },
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "mcp__tg__send", arguments: JSON.stringify({ text: "hello" }) } }] } }],
    },
    {
      model: "provider/free-model",
      usage: { prompt_tokens: 8, completion_tokens: 4 },
      choices: [{ message: { role: "assistant", content: "done" } }],
    },
    {
      model: "provider/free-model",
      usage: { prompt_tokens: 9, completion_tokens: 4 },
      choices: [{ message: { role: "assistant", content: "resumed" } }],
    },
  ];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "openrouter/free", context_length: 20_000, supported_parameters: ["tools"], architecture: { input_modalities: ["text"] } }] }), { status: 200 });
    }
    chatBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
  try {
    const { OpenRouterAgentSession } = await import("../src/openrouter-session.ts");
    const makeSession = (sessionId: string | null) => {
      const sent: string[] = [];
      let resolveEnded!: (result: any) => void;
      const ended = new Promise<any>((resolve) => (resolveEnded = resolve));
      const hooks = {
        beginTurn: async () => {},
        session: (_id: string) => {},
        model: (_model: string) => {},
        text: (_text: string) => {},
        tool: (_name: string, _input?: unknown) => {},
        endTurn: async (result: any) => resolveEnded(result),
      };
      const session = new OpenRouterAgentSession({
        bot: {} as any,
        threadId: 1,
        cwd: process.cwd(),
        sessionId,
        effort: null,
        model: null,
        serviceTier: null,
        openrouter: { model: null },
        channel: {
          server: {} as any,
          send: async (args: any) => {
            sent.push(args.text);
            return { content: [{ type: "text", text: "sent" }] };
          },
          get sent() {
            return sent.length;
          },
          resetSent: () => sent.splice(0),
        } as any,
        hooks,
      });
      return { session, ended, sent };
    };

    const first = makeSession(null);
    await first.session.send({ text: "first", images: [] });
    const firstResult = await first.ended;
    assert.equal(firstResult.sent, 1);
    assert.equal(firstResult.resolvedModel, "provider/free-model");
    assert.equal(chatBodies.length, 2);

    // The id is exposed through the hook in the real TopicSession; find the one
    // persisted history file without relying on a private field here.
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(process.env.OPENROUTER_HISTORY_PATH!);
    assert.equal(files.length, 1);
    const id = files[0]!.replace(/\.jsonl$/, "");
    const second = makeSession(id);
    await second.session.send({ text: "second", images: [] });
    const secondResult = await second.ended;
    assert.equal(secondResult.sent, 0);
    assert.ok(chatBodies[2].messages.length >= 5);
    assert.equal(secondResult.failure, null);
    first.session.close();
    second.session.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter stop aborts the pending request and keeps prior usage", async () => {
  const originalFetch = globalThis.fetch;
  let chatCalls = 0;
  let secondRequest!: () => void;
  const secondStarted = new Promise<void>((resolve) => (secondRequest = resolve));
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "openrouter/free", context_length: 20_000, supported_parameters: ["tools"] }] }), { status: 200 });
    }
    chatCalls++;
    if (chatCalls === 1) {
      return new Response(
        JSON.stringify({
          model: "openrouter/free",
          usage: { prompt_tokens: 4, completion_tokens: 2, cost: 0 },
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "stop-call", type: "function", function: { name: "Write", arguments: JSON.stringify({ file_path: "stop.txt", content: "once" }) } }] } }],
        }),
        { status: 200 },
      );
    }
    secondRequest();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  try {
    const { OpenRouterAgentSession } = await import("../src/openrouter-session.ts");
    const dir = await mkdtemp(join(tmpdir(), "openrouter-stop-"));
    let resolveEnded!: (result: any) => void;
    const ended = new Promise<any>((resolve) => (resolveEnded = resolve));
    const session = new OpenRouterAgentSession({
      bot: {} as any,
      threadId: 2,
      cwd: dir,
      sessionId: null,
      effort: null,
      model: null,
      serviceTier: null,
      openrouter: { model: null },
      channel: {
        server: {} as any,
        send: async () => ({ content: [{ type: "text", text: "sent" }] }),
        sent: 0,
        resetSent: () => {},
      } as any,
      hooks: {
        beginTurn: async () => {},
        session: () => {},
        text: () => {},
        tool: () => {},
        endTurn: async (result: any) => resolveEnded(result),
      },
    });
    await session.send({ text: "stop after one request", images: [] });
    await secondStarted;
    assert.equal(await session.interrupt(), true);
    const result = await ended;
    assert.equal(result.stopped, true);
    assert.equal(result.failure, null);
    assert.deepEqual(result.usage, { inTokens: 4, outTokens: 2, costUsd: 0 });
    session.close();
    await rm(dir, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter executor performs file tools and shell through the shared tool surface", async () => {
  process.env.BOT_TOKEN ??= "test-token";
  process.env.FORUM_CHAT_ID ??= "-100123";
  process.env.ALLOWED_USER_ID ??= "1";
  process.env.DEFAULT_CWD ??= process.cwd();
  process.env.PERMISSION = "bypass";
  const { executeOpenRouterTool } = await import("../src/openrouter-tools.ts");
  const dir = await mkdtemp(join(tmpdir(), "openrouter-tools-"));
  const ctx = {
    bot: {} as any,
    threadId: 1,
    cwd: dir,
    channel: { send: async () => ({ content: [{ type: "text", text: "sent" }] }) } as any,
    signal: new AbortController().signal,
    deliverTelegram: true,
  };
  try {
    await executeOpenRouterTool("Write", { file_path: "note.txt", content: "hello\nworld" }, ctx);
    assert.match(await executeOpenRouterTool("Read", { file_path: "note.txt" }, ctx), /hello/);
    await executeOpenRouterTool("Edit", { file_path: "note.txt", old_string: "world", new_string: "router" }, ctx);
    assert.match(await executeOpenRouterTool("Bash", { command: "printf shell-ok" }, ctx), /shell-ok/);
    assert.match(await executeOpenRouterTool("Glob", { pattern: "**/*.txt" }, ctx), /note\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
