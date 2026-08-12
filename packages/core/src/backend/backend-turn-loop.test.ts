import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HertaToAgentBrief } from "../bridge/types.js";
import { InMemoryEventBus } from "../event-bus.js";
import { NoopMemoryManager } from "../memory-manager.js";
import {
  NoopPermissionEngine,
  RulePermissionEngine,
} from "../permission-engine.js";
import { ReadLedger } from "../read-ledger.js";
import { FakeAskResolver } from "../testing/fake-ask-resolver.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { TodoStore } from "../todo-store.js";
import { InMemoryToolRegistry } from "../tool-registry.js";
import { TranscriptStore } from "../transcript-store.js";
import type { AgentEvent } from "../types/events.js";
import type {
  ProviderAdapter,
  ProviderPromptFrame,
} from "../types/provider.js";
import type { HertaTool } from "../types/tool.js";
import { BackendContextBuilder } from "./backend-context-builder.js";
import {
  partitionToolCalls,
  runBackendTurnLoop,
  summarizeInput,
} from "./backend-turn-loop.js";
import { BackgroundHost } from "./background-host.js";

const sampleBrief: HertaToAgentBrief = { taskId: "t-1" };
const sampleUserText = "fix the parser test";
const sampleUserMessages = [{ text: sampleUserText }];

function buildDeps(provider: FakeProvider) {
  const tools = new InMemoryToolRegistry();
  return {
    sessionId: "s-1",
    provider,
    tools,
    permissions: new NoopPermissionEngine(),
    backendBuilder: new BackendContextBuilder({ tools }),
    transcript: new TranscriptStore(),
    todos: new TodoStore(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    clock: () => new Date("2026-05-07T00:00:00.000Z"),
    workspaceRoot: "/repo",
    reads: new ReadLedger(),
    memory: new NoopMemoryManager(),
  };
}

describe("runBackendTurnLoop", () => {
  it("runs a brief to completion when the provider stops without tool calls", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "no changes needed" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = buildDeps(provider);

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("assistant.delta");
    expect(types).toContain("assistant.final");
    expect(types).toContain("turn.finished");
    expect(types).not.toContain("turn.failed");
  });

  it("does NOT append the brief's userRequestQuoted to the transcript", async () => {
    const provider = new FakeProvider({
      turns: [[{ type: "finish", reason: "stop" }]],
    });
    const deps = buildDeps(provider);

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      // drain
    }

    const messages = deps.transcript.all();
    const userMessages = messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(0);
  });

  it("uses BackendContextBuilder to build the frame fed to the provider", async () => {
    let capturedFrame: ProviderPromptFrame | undefined;
    const provider = new FakeProvider({
      turns: [
        (frame) => {
          capturedFrame = frame;
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const deps = buildDeps(provider);

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      // drain
    }

    expect(capturedFrame).toBeDefined();
    if (capturedFrame !== undefined) {
      expect("backendSystem" in capturedFrame).toBe(true);
      if ("backendSystem" in capturedFrame) {
        expect(capturedFrame.backendSystem).toContain(
          "你是后端的编码执行智能体",
        );
        // Post-May-2026: the user's actual words are threaded via
        // BackendTurnHandle.userMessages and rendered into backendSystem
        // via serializeUserHistory. No more hertaInterpretation framing.
        expect(capturedFrame.backendSystem).toContain(sampleUserText);
      }
    }
  });

  it("runs a brief through a tool-call cycle", async () => {
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "read_file",
      schema: () => ({
        name: "read_file",
        description: "Read a file from the workspace",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      }),
      run: async () => ({
        ok: true,
        data: { content: "fake file body" },
        summary: "read 1 file",
      }),
    });

    const provider = new FakeProvider({
      turns: [
        // Turn 1: model requests a tool call.
        [
          {
            type: "tool-call-request",
            call: {
              id: "call-1",
              tool: "read_file",
              input: { path: "src/parser.ts" },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        // Turn 2: after tool result is appended, model finishes with no further calls.
        [{ type: "finish", reason: "stop" }],
      ],
    });

    // Build deps but reuse the registry above (not the helper's empty one).
    const deps = {
      sessionId: "s-1",
      provider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({ tools }),
      transcript: new TranscriptStore(),
      todos: new TodoStore(),
      bg: new BackgroundHost(),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: "/repo",
      reads: new ReadLedger(),
      memory: new NoopMemoryManager(),
    };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("tool.call.started");
    expect(types).toContain("tool.call.finished");
    expect(types).toContain("turn.finished");
    expect(types).not.toContain("turn.failed");

    const messages = deps.transcript.all();
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect(toolMsgs).toHaveLength(1);

    const finished = events.find((e) => e.type === "turn.finished");
    expect(finished?.type).toBe("turn.finished");
    if (finished?.type === "turn.finished") {
      expect(finished.summary.toolCallCount).toBe(1);
    }
  });

  it("builds the base frame ONCE per turn; iterations only refresh messages (audit L2)", async () => {
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "read_file",
      schema: () => ({
        name: "read_file",
        description: "read",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, data: { content: "x" }, summary: "read" }),
    });

    const inner = new BackendContextBuilder({ tools });
    let builds = 0;
    const countingBuilder = {
      build: (input: Parameters<BackendContextBuilder["build"]>[0]) => {
        builds += 1;
        return inner.build(input);
      },
    } as BackendContextBuilder;

    const frames: ProviderPromptFrame[] = [];
    const provider = new FakeProvider({
      turns: [
        (frame) => {
          frames.push(frame);
          return [
            {
              type: "tool-call-request",
              call: { id: "c1", tool: "read_file", input: {} },
            },
            { type: "finish", reason: "tool_calls" },
          ];
        },
        (frame) => {
          frames.push(frame);
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });

    const deps = {
      sessionId: "s-1",
      provider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: countingBuilder,
      transcript: new TranscriptStore(),
      todos: new TodoStore(),
      bg: new BackgroundHost(),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: "/repo",
      reads: new ReadLedger(),
      memory: new NoopMemoryManager(),
    };

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      // drain
    }

    // One base build across BOTH iterations…
    expect(builds).toBe(1);
    // …while each iteration's frame still carried a fresh transcript: the
    // second call saw the first iteration's assistant + tool messages.
    expect(frames).toHaveLength(2);
    const m0 = frames[0];
    const m1 = frames[1];
    if (
      m0 !== undefined &&
      m1 !== undefined &&
      "messages" in m0 &&
      "messages" in m1
    ) {
      expect(m0.messages.length).toBe(0);
      expect(m1.messages.length).toBeGreaterThan(m0.messages.length);
    } else {
      throw new Error("expected backend frames with messages");
    }
  });

  it("classifies a tool that throws AbortError as interrupted, not tool_failed (audit M4)", async () => {
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "search_text",
      schema: () => ({
        name: "search_text",
        description: "search",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => {
        // The fs walkers (and run_command's runner) surface an interrupt as
        // an AbortError throw — the loop must rethrow it to the outer catch
        // instead of wrapping it as tool_failed.
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });

    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "call-1", tool: "search_text", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });

    const deps = {
      sessionId: "s-1",
      provider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({ tools }),
      transcript: new TranscriptStore(),
      todos: new TodoStore(),
      bg: new BackgroundHost(),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: "/repo",
      reads: new ReadLedger(),
      memory: new NoopMemoryManager(),
    };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.kind).toBe("interrupted");
    }
  });

  it("threads scopedRepoInstructions and scopedMemory into the frame", async () => {
    let capturedFrame: ProviderPromptFrame | undefined;
    const provider = new FakeProvider({
      turns: [
        (frame) => {
          capturedFrame = frame;
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const deps = buildDeps(provider);

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
      scopedRepoInstructions: "Prefer edit_file over write_new_file.",
      scopedMemory: "User dislikes long replies.",
    })) {
      // drain
    }

    expect(capturedFrame).toBeDefined();
    if (capturedFrame !== undefined && "backendSystem" in capturedFrame) {
      expect(capturedFrame.scopedRepoInstructions).toBe(
        "Prefer edit_file over write_new_file.",
      );
      expect(capturedFrame.scopedMemory).toBe("User dislikes long replies.");
    }
  });
});

describe("context budget + oversized-result persistence (ADR 0025 slice 2)", () => {
  const blobTool = (chars: number): HertaTool => ({
    name: "blob",
    schema: () => ({ name: "blob", description: "", inputSchema: {} }),
    run: async () => ({
      ok: true,
      summary: "made a blob",
      data: { content: "x".repeat(chars) },
    }),
  });

  it("persists an oversized tool result: event carries full, transcript carries preview+path, file lands on disk", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "herta-turnloop-"));
    try {
      const frames: ProviderPromptFrame[] = [];
      const provider = new FakeProvider({
        turns: [
          [
            {
              type: "tool-call-request",
              call: { id: "b1", tool: "blob", input: {} },
            },
            { type: "finish", reason: "tool_calls" },
          ],
          (frame) => {
            frames.push(frame);
            return [
              { type: "text-delta", text: "done" },
              { type: "finish", reason: "stop" },
            ];
          },
        ],
      });
      const deps = { ...buildDeps(provider), workspaceRoot: wsRoot };
      deps.tools.register(blobTool(60_000));

      const events: AgentEvent[] = [];
      for await (const e of runBackendTurnLoop(deps, sampleBrief, {
        signal: new AbortController().signal,
        userMessages: sampleUserMessages,
      })) {
        events.push(e);
      }

      // Event carries the FULL result (report absorber / renderer contract).
      const fin = events.find((e) => e.type === "tool.call.finished");
      if (fin?.type !== "tool.call.finished") throw new Error("no finish");
      expect((fin.result.data as { content?: string }).content?.length).toBe(
        60_000,
      );

      // Transcript stores the bounded pointer variant.
      const toolMsg = deps.transcript.all().find((m) => m.role === "tool");
      if (toolMsg?.role !== "tool") throw new Error("no tool msg");
      const data = toolMsg.result.data as {
        persisted?: boolean;
        path?: string;
        preview?: string;
      };
      expect(data.persisted).toBe(true);
      expect(data.path).toBe(".herta/tool-results/t-1/b1.json");
      expect(
        readFileSync(
          join(wsRoot, ".herta", "tool-results", "t-1", "b1.json"),
          "utf8",
        ),
      ).toContain("xxxx");

      // And that's what the NEXT provider call actually saw.
      const seen = frames[0];
      if (seen === undefined || !("messages" in seen)) throw new Error();
      const seenTool = seen.messages.find((m) => m.role === "tool");
      if (seenTool?.role !== "tool") throw new Error();
      expect((seenTool.result.data as { persisted?: boolean }).persisted).toBe(
        true,
      );
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  it("trims the frame to the working-set budget: later iterations see the marker, transcript stays complete", async () => {
    // 15K estimated tokens per fat assistant text — dwarfs the contract's
    // own base tokens so the budget arithmetic is dominated by messages.
    const fat = "A".repeat(60_000);
    const frames: ProviderPromptFrame[] = [];
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: fat },
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "blob", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: fat },
          {
            type: "tool-call-request",
            call: { id: "c2", tool: "blob", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        (frame) => {
          frames.push(frame);
          return [
            { type: "text-delta", text: "done" },
            { type: "finish", reason: "stop" },
          ];
        },
      ],
    });
    const deps = {
      ...buildDeps(provider),
      // base (~3K) + one fat group (~15K) fits; two fat groups (~33K) don't.
      budget: { budgetTokens: 20_000, keepRecentToolPayloads: 1 },
    };
    deps.tools.register(blobTool(10));

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    // The turn completed (no failure) despite the tiny budget.
    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    expect(events.some((e) => e.type === "turn.finished")).toBe(true);

    // The 3rd iteration's frame was trimmed: marker first, last group kept.
    const seen = frames[0];
    if (seen === undefined || !("messages" in seen)) throw new Error();
    const first = seen.messages[0];
    expect(first?.role).toBe("assistant");
    if (first?.role === "assistant") {
      expect(first.text).toContain("上下文已裁剪");
    }
    // The durable transcript is NOT trimmed: 2×(assistant+tool) + the
    // final "done" assistant = 5 full messages, no marker among them.
    expect(deps.transcript.all()).toHaveLength(5);
    expect(
      deps.transcript
        .all()
        .some((m) => m.role === "assistant" && m.text.includes("上下文已裁剪")),
    ).toBe(false);

    // The dropped fat text is absent from the frame, present in the store.
    const frameChars = seen.messages
      .map((m) => (m.role === "assistant" ? m.text : ""))
      .join("").length;
    expect(frameChars).toBeLessThan(70_000);
  });

  it("fails honestly (no provider call) when even the trimmed tail exceeds the budget", async () => {
    const provider = new FakeProvider({ turns: [] }); // any call would throw
    const deps = {
      ...buildDeps(provider),
      budget: { budgetTokens: 10, keepRecentToolPayloads: 1 },
    };
    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    const failed = events.find((e) => e.type === "turn.failed");
    if (failed?.type !== "turn.failed") throw new Error("expected failure");
    expect(failed.error.message).toContain("working-set budget");
  });
});

describe("verification.finished producer (test-result beat, 2026-07-23)", () => {
  function runCommandTurn(data: Record<string, unknown>) {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "r1", tool: "run_command", input: { argv: ["x"] } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = buildDeps(provider);
    deps.tools.register({
      name: "run_command",
      schema: () => ({ name: "run_command", description: "", inputSchema: {} }),
      run: async () => ({ ok: true, summary: "ran", data }),
    });
    return { deps, provider };
  }

  it("emits verification.finished AFTER the tool.call.finished of a test run", async () => {
    const { deps } = runCommandTurn({
      testRun: { status: "passed", summary: "3 passed" },
    });
    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    const types = events.map((e) => e.type);
    const finIdx = types.indexOf("tool.call.finished");
    const verIdx = types.indexOf("verification.finished");
    expect(finIdx).toBeGreaterThanOrEqual(0);
    expect(verIdx).toBeGreaterThan(finIdx);
  });

  it("does NOT emit verification.finished for an ordinary command", async () => {
    const { deps } = runCommandTurn({ exitCode: 0, stdout: "hello" });
    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    expect(events.some((e) => e.type === "verification.finished")).toBe(false);
  });
});

describe("partitionToolCalls (ADR 0025 slice 5)", () => {
  const call = (id: string, tool: string) => ({ id, tool, input: {} });
  const safe = (name: string) => name.startsWith("r_");

  it("groups runs of ≥2 consecutive safe calls; everything else is a serial single", () => {
    const batches = partitionToolCalls(
      [
        call("1", "r_a"),
        call("2", "r_b"),
        call("3", "w_x"),
        call("4", "r_c"),
        call("5", "r_d"),
        call("6", "r_e"),
        call("7", "w_y"),
      ],
      safe,
    );
    expect(
      batches.map((b) => `${b.parallel ? "P" : "S"}:${b.calls.length}`),
    ).toEqual(["P:2", "S:1", "P:3", "S:1"]);
    // Order preserved end to end.
    expect(batches.flatMap((b) => b.calls.map((c) => c.id))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
  });

  it("a lone safe call stays serial; empty input yields no batches", () => {
    expect(partitionToolCalls([call("1", "r_a")], safe)).toEqual([
      { parallel: false, calls: [call("1", "r_a")] },
    ]);
    expect(partitionToolCalls([], safe)).toEqual([]);
  });
});

describe("malformed tool-args containment (2026-08-13)", () => {
  /** A call the provider could not parse — the shape stream.ts now yields
   *  instead of throwing ProviderError{code:"tool-args"}. */
  const badCall = (id: string, tool = "run_command") => ({
    type: "tool-call-request" as const,
    call: {
      id,
      tool,
      input: {},
      malformedArgs: {
        raw: '{"argv": ["grep", "-o", ".\\{0,40\\}checksum", "f.json"]}',
        parseError: "Bad escaped character in JSON at position 34",
      },
    },
  });

  it("answers the model instead of killing the turn, and never runs the tool", async () => {
    // Pre-fix this threw out of the provider, backend-error-policy classified
    // it terminal, and the whole brief died on the FIRST occurrence — with
    // every tool call already executed in that turn discarded.
    const provider = new FakeProvider({
      turns: [
        [badCall("c1"), { type: "finish", reason: "tool_calls" }],
        [
          { type: "text-delta", text: "recovered" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = buildDeps(provider);
    let ran = 0;
    deps.tools.register({
      name: "run_command",
      schema: () => ({ name: "run_command", description: "", inputSchema: {} }),
      run: async () => {
        ran += 1;
        return { ok: true, summary: "ran" };
      },
    });

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    expect(events.some((e) => e.type === "turn.finished")).toBe(true);
    // The tool must NOT have run: there was no parsed input to run it with.
    expect(ran).toBe(0);

    const fin = events.find((e) => e.type === "tool.call.finished");
    if (fin?.type !== "tool.call.finished") throw new Error("no finish");
    expect(fin.result.ok).toBe(false);
    expect(fin.result.error?.code).toBe("malformed_tool_args");
    // The suggestion has to name the real mechanism — a model told only
    // "invalid JSON" re-sends the same string.
    expect(fin.result.suggestion).toContain("backslash");
    // And it must say the tool did not run, or the model may assume it did.
    expect(fin.result.suggestion).toContain("did NOT run");

    // It reached the transcript: every tool_call_id needs a matching tool
    // message or the NEXT provider request 400s.
    const toolMsg = deps.transcript.all().find((m) => m.role === "tool");
    if (toolMsg?.role !== "tool") throw new Error("no tool msg");
    expect(toolMsg.result.error?.code).toBe("malformed_tool_args");
  });

  it("never asks the permission engine about a call it could not parse", async () => {
    const provider = new FakeProvider({
      turns: [
        [badCall("c1"), { type: "finish", reason: "tool_calls" }],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = buildDeps(provider);
    let checked = 0;
    const inner = deps.permissions;
    deps.permissions = {
      check: async (call, ctx) => {
        checked += 1;
        return inner.check(call, ctx);
      },
    } as typeof deps.permissions;

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      // drain
    }
    expect(checked).toBe(0);
  });

  it("a good call in the same iteration still runs", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          badCall("c1"),
          {
            type: "tool-call-request",
            call: { id: "c2", tool: "fine", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = buildDeps(provider);
    let ran = 0;
    deps.tools.register({
      name: "fine",
      schema: () => ({ name: "fine", description: "", inputSchema: {} }),
      run: async () => {
        ran += 1;
        return { ok: true, summary: "fine ok" };
      },
    });

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      // drain
    }
    expect(ran).toBe(1);
    const toolMsgs = deps.transcript.all().filter((m) => m.role === "tool");
    // Both ids answered — the malformed one and the executed one.
    expect(toolMsgs).toHaveLength(2);
  });

  it("gives up after repeated malformed args instead of spinning", async () => {
    // Containment must not become an infinite loop when the model cannot
    // correct itself.
    const provider = new FakeProvider({
      turns: [
        [badCall("c1"), { type: "finish", reason: "tool_calls" }],
        [badCall("c2"), { type: "finish", reason: "tool_calls" }],
        [badCall("c3"), { type: "finish", reason: "tool_calls" }],
        [badCall("c4"), { type: "finish", reason: "tool_calls" }],
        [
          { type: "text-delta", text: "never reached" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = buildDeps(provider);

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const failed = events.find((e) => e.type === "turn.failed");
    if (failed?.type !== "turn.failed") throw new Error("expected turn.failed");
    expect(failed.error.message).toContain("malformed tool arguments");
    // It failed AFTER telling the model, not on the first occurrence.
    const finished = events.filter((e) => e.type === "tool.call.finished");
    expect(finished.length).toBeGreaterThanOrEqual(3);
  });
});

describe("tool-crash containment + parallel read-only batches (ADR 0025 slice 5)", () => {
  it("an uncaught tool throw becomes a model-visible tool_crashed result; the turn continues", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "boom", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "recovered" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = buildDeps(provider);
    deps.tools.register({
      name: "boom",
      schema: () => ({ name: "boom", description: "", inputSchema: {} }),
      run: async () => {
        throw new Error("driver exploded");
      },
    });

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    expect(events.some((e) => e.type === "turn.finished")).toBe(true);
    const fin = events.find((e) => e.type === "tool.call.finished");
    if (fin?.type !== "tool.call.finished") throw new Error("no finish");
    expect(fin.result.ok).toBe(false);
    expect(fin.result.error?.code).toBe("tool_crashed");
    expect(fin.result.error?.message).toContain("driver exploded");
    expect(fin.result.error?.retryable).toBe(false);
    // The crash landed in the transcript so the model can route around it.
    const toolMsg = deps.transcript.all().find((m) => m.role === "tool");
    if (toolMsg?.role !== "tool") throw new Error("no tool msg");
    expect(toolMsg.result.error?.code).toBe("tool_crashed");
  });

  it("consecutive read-only calls execute CONCURRENTLY, with events and transcript in call order", async () => {
    // A completes only after B has STARTED — a serial loop would deadlock
    // (vitest's timeout guards the regression); the parallel batch makes
    // it trivially safe.
    let releaseA!: () => void;
    const bStarted = new Promise<void>((r) => {
      releaseA = r;
    });
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "a", tool: "slow_read", input: {} },
          },
          {
            type: "tool-call-request",
            call: { id: "b", tool: "fast_read", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = buildDeps(provider);
    deps.tools.register({
      name: "slow_read",
      readOnly: true,
      schema: () => ({ name: "slow_read", description: "", inputSchema: {} }),
      run: async () => {
        await bStarted;
        return { ok: true, data: { v: "A" }, summary: "slow done" };
      },
    });
    deps.tools.register({
      name: "fast_read",
      readOnly: true,
      schema: () => ({ name: "fast_read", description: "", inputSchema: {} }),
      run: async () => {
        releaseA();
        return { ok: true, data: { v: "B" }, summary: "fast done" };
      },
    });

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    // Both started before either finished; finished events in CALL order
    // (a then b) even though b completed first.
    const seq = events
      .filter(
        (e) =>
          e.type === "tool.call.started" || e.type === "tool.call.finished",
      )
      .map((e) =>
        e.type === "tool.call.started" ? `start:${e.id}` : `fin:${e.id}`,
      );
    expect(seq).toEqual(["start:a", "start:b", "fin:a", "fin:b"]);
    // Transcript in call order too.
    const toolMsgs = deps.transcript
      .all()
      .filter((m) => m.role === "tool")
      .map((m) => (m.role === "tool" ? m.toolCallId : ""));
    expect(toolMsgs).toEqual(["a", "b"]);
  });

  it("a crash inside a parallel batch is contained per call; siblings still succeed", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "g", tool: "good_read", input: {} },
          },
          {
            type: "tool-call-request",
            call: { id: "x", tool: "bad_read", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = buildDeps(provider);
    deps.tools.register({
      name: "good_read",
      readOnly: true,
      schema: () => ({ name: "good_read", description: "", inputSchema: {} }),
      run: async () => ({ ok: true, summary: "fine" }),
    });
    deps.tools.register({
      name: "bad_read",
      readOnly: true,
      schema: () => ({ name: "bad_read", description: "", inputSchema: {} }),
      run: async () => {
        throw new Error("parallel boom");
      },
    });

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    expect(events.some((e) => e.type === "turn.failed")).toBe(false);
    const fins = events.filter((e) => e.type === "tool.call.finished");
    expect(fins).toHaveLength(2);
    const good = fins.find(
      (e) => e.type === "tool.call.finished" && e.id === "g",
    );
    const bad = fins.find(
      (e) => e.type === "tool.call.finished" && e.id === "x",
    );
    if (good?.type !== "tool.call.finished") throw new Error();
    if (bad?.type !== "tool.call.finished") throw new Error();
    expect(good.result.ok).toBe(true);
    expect(bad.result.error?.code).toBe("tool_crashed");
  });

  it("tools WITHOUT readOnly stay strictly serial (B starts only after A completes)", async () => {
    let aCompleted = false;
    let bSawACompleted = false;
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "a", tool: "write_a", input: {} },
          },
          {
            type: "tool-call-request",
            call: { id: "b", tool: "write_b", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = buildDeps(provider);
    deps.tools.register({
      name: "write_a",
      schema: () => ({ name: "write_a", description: "", inputSchema: {} }),
      run: async () => {
        await new Promise((r) => setTimeout(r, 20));
        aCompleted = true;
        return { ok: true, summary: "a done" };
      },
    });
    deps.tools.register({
      name: "write_b",
      schema: () => ({ name: "write_b", description: "", inputSchema: {} }),
      run: async () => {
        bSawACompleted = aCompleted;
        return { ok: true, summary: "b done" };
      },
    });

    for await (const _ of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      // drain
    }
    expect(bSawACompleted).toBe(true);
  });

  it("an abort thrown inside a parallel batch still interrupts the turn", async () => {
    const ac = new AbortController();
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "a", tool: "abort_read", input: {} },
          },
          {
            type: "tool-call-request",
            call: { id: "b", tool: "calm_read", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });
    const deps = buildDeps(provider);
    deps.tools.register({
      name: "abort_read",
      readOnly: true,
      schema: () => ({ name: "abort_read", description: "", inputSchema: {} }),
      run: async () => {
        ac.abort();
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    deps.tools.register({
      name: "calm_read",
      readOnly: true,
      schema: () => ({ name: "calm_read", description: "", inputSchema: {} }),
      run: async () => ({ ok: true, summary: "calm" }),
    });

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: ac.signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    const failed = events.find((e) => e.type === "turn.failed");
    if (failed?.type !== "turn.failed") throw new Error("expected interrupt");
    expect(failed.error.kind).toBe("interrupted");
  });
});

describe("summarizeInput (tool-aware working-state argument)", () => {
  it("normalizes newlines to spaces — the summary is a one-line header (slice 6)", () => {
    expect(
      summarizeInput("run_command", {
        argv: ["echo", "first\nsecond\r\nthird"],
      }),
    ).toBe("echo first second third");
    expect(summarizeInput("read_file", { path: "src/\nfake-header.ts" })).toBe(
      "src/ fake-header.ts",
    );
  });

  it("returns the path for write_new_file (no content blob)", () => {
    expect(
      summarizeInput("write_new_file", {
        path: "scripts/merge_sort.py",
        content: "#!/usr/bin/env python3\n…lots of code…",
      }),
    ).toBe("scripts/merge_sort.py");
  });

  it("returns the path for edit_file (no hunks)", () => {
    expect(
      summarizeInput("edit_file", {
        path: "src/foo.ts",
        hunks: [{ search: "a", replace: "b" }],
      }),
    ).toBe("src/foo.ts");
  });

  it("returns the path for read_file", () => {
    expect(summarizeInput("read_file", { path: "src/foo.ts" })).toBe(
      "src/foo.ts",
    );
  });

  it("returns the dir for list_files, defaulting to '.'", () => {
    expect(summarizeInput("list_files", { recursive: true })).toBe(".");
    expect(summarizeInput("list_files", { path: "src" })).toBe("src");
  });

  it("returns the quoted pattern for search_text", () => {
    expect(summarizeInput("search_text", { pattern: "mergesort" })).toBe(
      '"mergesort"',
    );
  });

  it("returns the kind for memory_save (not the full text body)", () => {
    expect(
      summarizeInput("memory_save", {
        kind: "repo_fact",
        text: "the build command is pnpm -w test",
      }),
    ).toBe("repo_fact");
  });

  it("returns the joined argv for run_command", () => {
    expect(summarizeInput("run_command", { argv: ["pytest", "-q"] })).toBe(
      "pytest -q",
    );
  });

  it("returns empty (verb-only) for git tools", () => {
    expect(summarizeInput("git_status", {})).toBe("");
    expect(summarizeInput("git_diff", { staged: true })).toBe("");
  });

  it("returns the done/total ratio for todo_write", () => {
    expect(
      summarizeInput("todo_write", {
        todos: [
          { content: "a", status: "completed" },
          { content: "b", status: "in_progress" },
          { content: "c", status: "pending" },
        ],
      }),
    ).toBe("1/3");
  });

  it("returns empty for todo_write with an empty or malformed list", () => {
    expect(summarizeInput("todo_write", { todos: [] })).toBe("");
    expect(summarizeInput("todo_write", { foo: 1 })).toBe("");
  });

  it("truncates a long path to the ~80-char cap with an ellipsis", () => {
    const longPath = `src/${"a".repeat(120)}.ts`;
    const out = summarizeInput("read_file", { path: longPath });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to JSON truncation for an unknown tool", () => {
    expect(summarizeInput("lore_search", { q: "walter" })).toBe(
      '{"q":"walter"}',
    );
  });

  it("falls back to JSON truncation when the expected field is missing", () => {
    expect(summarizeInput("read_file", { wrong: 1 })).toBe('{"wrong":1}');
  });

  it("never throws on non-object input (defensive)", () => {
    expect(() => summarizeInput("read_file", null)).not.toThrow();
    expect(() => summarizeInput("read_file", 42)).not.toThrow();
  });
});

/** A structural ProviderError stand-in (core can't import @herta/providers). */
class FakeProviderError extends Error {
  override readonly name = "ProviderError";
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(code: string, retryable: boolean, status?: number) {
    super(`${code} error`);
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

describe("runBackendTurnLoop — provider error resilience", () => {
  it("retries a transient provider failure and completes the turn", async () => {
    const provider = new FakeProvider({
      turns: [
        () => {
          throw new FakeProviderError("sse", true);
        },
        [
          { type: "text-delta", text: "recovered" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const deps = { ...buildDeps(provider), sleep: () => Promise.resolve() };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("turn.finished");
    expect(types).not.toContain("turn.failed");
  });

  it("surfaces turn.failed when a transient failure persists past the retry budget", async () => {
    const provider = new FakeProvider({
      turns: Array.from({ length: 20 }, () => () => {
        throw new FakeProviderError("sse", true);
      }),
    });
    const deps = { ...buildDeps(provider), sleep: () => Promise.resolve() };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.kind).toBe("provider_failed");
    }
    expect(events.map((e) => e.type)).not.toContain("turn.finished");
  });

  it("does NOT retry a terminal 4xx — surfaces immediately, one attempt only", async () => {
    let attempts = 0;
    const provider = new FakeProvider({
      turns: [
        () => {
          attempts += 1;
          // A content-filter / safety block arrives as a 400, flagged retryable
          // — provider-patterns-first must keep it terminal anyway.
          throw new FakeProviderError("http", true, 400);
        },
        // Would succeed if (wrongly) retried — must never be reached.
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = { ...buildDeps(provider), sleep: () => Promise.resolve() };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    expect(attempts).toBe(1);
    expect(events.map((e) => e.type)).toContain("turn.failed");
    expect(events.map((e) => e.type)).not.toContain("turn.finished");
  });

  it("bounds a runaway tool-loop at MAX_TURN_ITERATIONS and surfaces turn.failed", async () => {
    // A provider that requests a tool call forever — without the iteration cap
    // this loops indefinitely.
    const loopingProvider: ProviderAdapter = {
      async *streamChat() {
        yield {
          type: "tool-call-request",
          call: { id: "c", tool: "noop", input: {} },
        };
        yield { type: "finish", reason: "tool_calls" };
      },
    };
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "noop",
      schema: () => ({
        name: "noop",
        description: "does nothing",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "noop" }),
    });
    const deps = {
      sessionId: "s-1",
      provider: loopingProvider,
      tools,
      permissions: new NoopPermissionEngine(),
      backendBuilder: new BackendContextBuilder({ tools }),
      transcript: new TranscriptStore(),
      todos: new TodoStore(),
      bg: new BackgroundHost(),
      bus: new InMemoryEventBus<AgentEvent>(),
      clock: () => new Date("2026-05-07T00:00:00.000Z"),
      workspaceRoot: "/repo",
      reads: new ReadLedger(),
      memory: new NoopMemoryManager(),
    };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.message).toContain("iterations");
    }
  });

  it("an interrupt during a pending gate produces NO permission.resolved and NO tool result (audit finding 4)", async () => {
    // The user presses Stop while the approval prompt is up. Production
    // resolvers reject the pending ask with an AbortError (they used to
    // resolve "deny", fabricating a user decision that entered the report
    // and the next dispatch's working history — the ADR-0010 class).
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "edit_file",
      schema: () => ({
        name: "edit_file",
        description: "patch a file",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "should never run" }),
    });
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    permissions.registerRule("edit_file", () => ({
      kind: "ask",
      reason: "writes a file",
      risk: "workspace_write",
    }));
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "call-1", tool: "edit_file", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = { ...buildDeps(provider), tools, permissions };
    const ac = new AbortController();

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: ac.signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
      if (e.type === "permission.requested") {
        // Same shape session.interrupt() aborts with.
        ac.abort(
          new DOMException("Interrupted by session.interrupt()", "AbortError"),
        );
      }
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("permission.requested");
    expect(types).not.toContain("permission.resolved");
    expect(types).not.toContain("tool.call.finished");
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.kind).toBe("interrupted");
    }
    // No fabricated "User denied" tool result in the model-facing transcript.
    expect(deps.transcript.all().some((m) => m.role === "tool")).toBe(false);
  });

  it("finishReason 'length' surfaces turn.failed — truncated output never reads as a clean turn end", async () => {
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "half a plan…" },
          { type: "finish", reason: "length" },
        ],
      ],
    });
    const deps = buildDeps(provider);
    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.message).toMatch(/token limit/);
    }
    expect(events.map((e) => e.type)).not.toContain("turn.finished");
  });

  it("a stream that ends WITHOUT a finish event surfaces turn.failed", async () => {
    // The provider generator just ends (connection cut mid-stream): the
    // default finishReason is "error" and the loop must not sail on.
    const provider = new FakeProvider({
      turns: [[{ type: "text-delta", text: "cut off" }]],
    });
    const deps = buildDeps(provider);
    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.message).toMatch(/without a finish event/);
    }
    expect(events.map((e) => e.type)).not.toContain("turn.finished");
  });

  it("an abort during the REAL backoff sleep classifies as interrupted (audit §6 missing-test)", async () => {
    // A retryable provider failure puts the loop into defaultBackoffSleep
    // (deps.sleep deliberately NOT injected here — this pins the real
    // abort-aware sleep, which tests otherwise always stub out). The abort
    // lands mid-backoff and must surface as `interrupted`, not as a retry
    // wedge or an `unknown` failure.
    const providerError = Object.assign(new Error("socket hang up"), {
      name: "ProviderError",
      code: "network",
      retryable: true,
    });
    const provider = new FakeProvider({
      turns: [
        () => {
          throw providerError;
        },
      ],
    });
    const deps = buildDeps(provider);
    const ac = new AbortController();
    setTimeout(
      () => ac.abort(new DOMException("Interrupted", "AbortError")),
      40,
    );
    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: ac.signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    if (failed?.type === "turn.failed") {
      expect(failed.error.kind).toBe("interrupted");
    }
  });

  it("a deterministic rule-deny emits permission.resolved{blocked} with the tool (audit finding 6)", async () => {
    const tools = new InMemoryToolRegistry();
    tools.register({
      name: "run_command",
      schema: () => ({
        name: "run_command",
        description: "run",
        inputSchema: { type: "object", properties: {} },
      }),
      run: async () => ({ ok: true, summary: "should never run" }),
    });
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    permissions.registerRule("run_command", () => ({
      kind: "deny",
      reason: "system control: shutdown",
      code: "command_blocked",
    }));
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "call-1", tool: "run_command", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const deps = { ...buildDeps(provider), tools, permissions };

    const events: AgentEvent[] = [];
    for await (const e of runBackendTurnLoop(deps, sampleBrief, {
      signal: new AbortController().signal,
      userMessages: sampleUserMessages,
    })) {
      events.push(e);
    }

    // Pre-fix nothing emitted a permission event on this path — the report's
    // status gate keyed on user denials only, so a policy-refused run could
    // still report `completed`.
    const resolved = events.find((e) => e.type === "permission.resolved");
    expect(resolved).toBeDefined();
    if (resolved?.type === "permission.resolved") {
      expect(resolved.decision).toBe("blocked");
      expect(resolved.tool).toBe("run_command");
    }
    // No user prompt fired for it.
    expect(events.map((e) => e.type)).not.toContain("permission.requested");
    // The structured refusal still reaches the transcript for the model.
    const finished = events.find((e) => e.type === "tool.call.finished");
    expect(finished).toBeDefined();
    if (finished?.type === "tool.call.finished") {
      expect(finished.result.ok).toBe(false);
      if (!finished.result.ok) {
        expect(finished.result.error?.code).toBe("command_blocked");
      }
    }
  });
});
