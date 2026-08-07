import { describe, expect, it, vi } from "vitest";
import { BackgroundHost } from "./backend/background-host.js";
import { StubContextBuilder } from "./context-builder.js";
import { InMemoryEventBus } from "./event-bus.js";
import { NoopMemoryManager } from "./memory-manager.js";
import { NoopPermissionEngine } from "./permission-engine.js";
import { ReadLedger } from "./read-ledger.js";
import { TodoStore } from "./todo-store.js";
import { InMemoryToolRegistry } from "./tool-registry.js";
import { TranscriptStore } from "./transcript-store.js";
import type { AgentEvent } from "./types/events.js";
import type { HertaTool, ToolContext } from "./types/tool.js";

const ctx: ToolContext = {
  sessionId: "s1",
  signal: new AbortController().signal,
  workspaceRoot: process.cwd(),
  reads: new ReadLedger(),
  todos: new TodoStore(),
  bg: new BackgroundHost(),
  bus: new InMemoryEventBus<AgentEvent>(),
  memory: new NoopMemoryManager(),
};

describe("NoopPermissionEngine", () => {
  it("always allows", async () => {
    const eng = new NoopPermissionEngine();
    const decision = await eng.check(
      { id: "x", tool: "read_file", input: {} },
      ctx,
    );
    expect(decision.kind).toBe("allow");
  });
});

describe("InMemoryToolRegistry", () => {
  const fakeTool: HertaTool = {
    name: "echo",
    schema: () => ({ name: "echo", description: "", inputSchema: {} }),
    run: async (call) => ({
      ok: true,
      data: call.input,
      summary: "echoed",
    }),
  };

  it("registers and retrieves tools by name", () => {
    const r = new InMemoryToolRegistry();
    r.register(fakeTool);
    expect(r.get("echo")).toBe(fakeTool);
    expect(r.list()).toEqual([fakeTool]);
  });

  it("runs a registered tool", async () => {
    const r = new InMemoryToolRegistry();
    r.register(fakeTool);
    const result = await r.run(
      { id: "1", tool: "echo", input: { x: 1 } },
      ctx,
      vi.fn(),
    );
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ x: 1 });
  });

  it("returns unknown_tool error when name is not registered", async () => {
    const r = new InMemoryToolRegistry();
    const result = await r.run(
      { id: "1", tool: "missing", input: {} },
      ctx,
      vi.fn(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("unknown_tool");
    expect(result.error?.retryable).toBe(false);
  });
});

describe("StubContextBuilder", () => {
  it("returns transcript messages and registered tool schemas", () => {
    const b = new StubContextBuilder();
    const t = new TranscriptStore();
    t.appendUser("hi", new Date());
    const r = new InMemoryToolRegistry();
    r.register({
      name: "echo",
      schema: () => ({ name: "echo", description: "d", inputSchema: {} }),
      run: async () => ({ ok: true, summary: "" }),
    });
    const frame = b.build(t, r);
    expect(frame.messages).toHaveLength(1);
    expect(frame.toolSchemas).toEqual([
      { name: "echo", description: "d", inputSchema: {} },
    ]);
  });
});

describe("NoopMemoryManager", () => {
  it("recall returns empty array", async () => {
    expect(await new NoopMemoryManager().recall({})).toEqual([]);
  });
  it("save resolves without throwing", async () => {
    const item = {
      id: "id-1",
      scope: "repo" as const,
      kind: "build_command" as const,
      text: "x",
      sourceSession: "s",
      createdAt: "2026-05-04T00:00:00.000Z",
      lastSeen: "2026-05-04T00:00:00.000Z",
      confidence: 1,
    };
    await expect(new NoopMemoryManager().save(item)).resolves.toBeUndefined();
  });
});
