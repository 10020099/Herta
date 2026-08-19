import type { BackendPromptFrame, PromptFrame } from "@herta/core";
import { describe, expect, it } from "vitest";
import { translate } from "./translate.js";

const baseOpts = {
  model: "deepseek-v4-pro",
  temperature: 0.3,
  maxTokens: 1024,
};

describe("translate", () => {
  it("emits a minimal user-only request", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "hello", ts: "2026-05-03T00:00:00Z" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      stream: true,
      temperature: 0.3,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("maps assistant tool-call + tool-result round-trip", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        { role: "user", text: "list", ts: "t" },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "call_1", tool: "list_files", input: { path: "." } },
          ],
          ts: "t",
        },
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, data: ["a.ts"], summary: "1 file" },
          ts: "t",
        },
        {
          role: "assistant",
          text: "Found a.ts.",
          toolCalls: [],
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: '{"path":"."}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '1 file\n\n{"data":["a.ts"]}',
      },
      { role: "assistant", content: "Found a.ts." },
    ]);
  });

  it("sends modelText verbatim when a tool authored it (ADR 0040) — summary/data stay harness-only", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: {
            ok: true,
            data: { exitCode: 1, stdout: "x" },
            summary: "ran `npm test` (exit 1)",
            modelText: "TAP version 13\nnot ok 1 - a\n[exit code: 1]",
          },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "TAP version 13\nnot ok 1 - a\n[exit code: 1]",
    });
  });

  it("uses JSON-stringified data when summary is empty", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, data: { x: 1 }, summary: "" },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"data":{"x":1}}',
    });
  });

  it("maps tool schemas to OpenAI tools array", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };
    const body = translate(frame, baseOpts);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("merges extraBody after base fields (vendor wins)", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [],
    };
    const body = translate(frame, {
      ...baseOpts,
      extraBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        temperature: 0.99,
      },
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBe(0.99);
  });

  it("omits temperature/max_tokens when not provided", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [],
    };
    const body = translate(frame, { model: "deepseek-v4-pro" });
    expect("temperature" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
  });

  it("prepends a system message when stableSystem is non-empty", () => {
    const frame: PromptFrame = {
      stableSystem: "HELLO HERTA",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "HELLO HERTA" },
      { role: "user", content: "ping" },
    ]);
  });

  it("does not emit a system message when stableSystem is empty", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("emits two system messages when both stableSystem and repoInstructions non-empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      repoInstructions: "R",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "system", content: "R" },
      { role: "user", content: "ping" },
    ]);
  });

  it("emits only stableSystem when repoInstructions is empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "ping" },
    ]);
  });

  it("emits three system messages when stable, repo, and memory all non-empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      repoInstructions: "R",
      memoryContext: "M",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "system", content: "R" },
      { role: "system", content: "M" },
      { role: "user", content: "ping" },
    ]);
  });

  it("threads reasoningContent back as reasoning_content on the assistant message", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        { role: "user", text: "list", ts: "t" },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "call_1", tool: "list_files", input: { path: "." } },
          ],
          ts: "t",
          reasoningContent: "The user wants files. Calling list_files.",
        },
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, data: ["a.ts"], summary: "1 file" },
          ts: "t",
        },
        {
          role: "assistant",
          text: "Found a.ts.",
          toolCalls: [],
          ts: "t",
          reasoningContent: "Result has one file.",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: '{"path":"."}' },
          },
        ],
        reasoning_content: "The user wants files. Calling list_files.",
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '1 file\n\n{"data":["a.ts"]}',
      },
      {
        role: "assistant",
        content: "Found a.ts.",
        reasoning_content: "Result has one file.",
      },
    ]);
  });

  it("omits reasoning_content when reasoningContent is empty or absent", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        { role: "assistant", text: "hi", toolCalls: [], ts: "t" },
        {
          role: "assistant",
          text: "still hi",
          toolCalls: [],
          ts: "t",
          reasoningContent: "",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    for (const m of body.messages) {
      expect("reasoning_content" in m).toBe(false);
    }
  });

  it("omits memoryContext system message when empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      repoInstructions: "R",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "system", content: "R" },
      { role: "user", content: "ping" },
    ]);
  });

  it("emits retrievedLore as a system message after memoryContext", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      repoInstructions: "R",
      memoryContext: "M",
      retrievedLore: "L",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "system", content: "R" },
      { role: "system", content: "M" },
      { role: "system", content: "L" },
      { role: "user", content: "ping" },
    ]);
  });

  it("omits retrievedLore system message when empty", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("emits summary + data envelope when both are present", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: {
            ok: true,
            data: { chunkId: "h12", title: "doc" },
            summary: "lore_search: 1 results for 'Herta'",
          },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content:
        'lore_search: 1 results for \'Herta\'\n\n{"data":{"chunkId":"h12","title":"doc"}}',
    });
  });

  it("emits error + suggestion alongside summary on a denied tool call", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: {
            ok: false,
            error: {
              code: "permission_denied",
              message: "User denied edit_file",
              retryable: false,
            },
            suggestion: "Choose a read-only inspection path or ask the user.",
            summary: "denied",
          },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content:
        'denied\n\n{"error":{"code":"permission_denied","message":"User denied edit_file","retryable":false},"suggestion":"Choose a read-only inspection path or ask the user."}',
    });
  });

  it("preserves summary-only output when no data is present (back-compat)", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, summary: "ok" },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "ok",
    });
  });

  it("emits literal {} when both summary and data are absent (degenerate fallback)", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      repoInstructions: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, summary: "" },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "{}",
    });
  });
});

describe("translateBackend", () => {
  function makeBackendFrame(
    overrides: Partial<BackendPromptFrame> = {},
  ): BackendPromptFrame {
    return {
      backendSystem: "You are the coding execution backend for Herta CLI.",
      scopedRepoInstructions: "",
      scopedMemory: "",
      toolSchemas: [],
      messages: [],
      ...overrides,
    };
  }

  it("emits backendSystem as a system message", () => {
    const frame = makeBackendFrame();
    const req = translate(frame, { model: "test-model" });
    expect(req.messages[0]).toEqual({
      role: "system",
      content: "You are the coding execution backend for Herta CLI.",
    });
  });

  it("emits scopedRepoInstructions and scopedMemory as additional system messages when non-empty", () => {
    const frame = makeBackendFrame({
      scopedRepoInstructions: "Prefer edit_file.",
      scopedMemory: "User dislikes long replies.",
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.messages).toEqual([
      { role: "system", content: frame.backendSystem },
      { role: "system", content: "Prefer edit_file." },
      { role: "system", content: "User dislikes long replies." },
    ]);
  });

  it("omits empty scoped fields", () => {
    const frame = makeBackendFrame({
      scopedRepoInstructions: "",
      scopedMemory: "",
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("forwards tool schemas to the OpenAI tools field", () => {
    const frame = makeBackendFrame({
      toolSchemas: [
        {
          name: "read_file",
          description: "read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.tools).toHaveLength(1);
    expect(req.tools?.[0]?.function.name).toBe("read_file");
  });

  it("forwards transcript messages after system messages", () => {
    const frame = makeBackendFrame({
      messages: [
        { role: "user", text: "hello", ts: "2026-05-07T00:00:00.000Z" },
      ],
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });
});
