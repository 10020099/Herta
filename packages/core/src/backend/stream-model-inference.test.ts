import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../event-bus.js";
import { FakeProvider } from "../testing/fake-provider.js";
import type { AgentEvent } from "../types/events.js";
import type { ProviderPromptFrame } from "../types/provider.js";
import {
  isAbortError,
  streamModelInference,
  toProviderError,
} from "./stream-model-inference.js";

function fakeFrame(): ProviderPromptFrame {
  // BackendPromptFrame is fine for the helper — it's frame-shape agnostic.
  return {
    backendSystem: "x",
    scopedRepoInstructions: "",
    scopedMemory: "",
    toolSchemas: [],
    messages: [],
    trace: { ts: "", activated: [], suppressed: [], budgets: [] },
  } as unknown as ProviderPromptFrame;
}

describe("streamModelInference", () => {
  it("accumulates text deltas and emits each delta on the bus", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));

    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "Hello " },
          { type: "text-delta", text: "world" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const result = await streamModelInference({
      provider,
      frame: fakeFrame(),
      signal: new AbortController().signal,
      bus,
      layer: "actor",
    });

    expect(result.text).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
    expect(result.deltas).toHaveLength(2);
    const deltas = events.filter((e) => e.type === "assistant.delta");
    expect(deltas).toHaveLength(2);
  });

  it("collects tool calls without emitting them on the bus", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "thinking..." },
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "read_file", input: { path: "x" } },
          },
          { type: "finish", reason: "tool_calls" },
        ],
      ],
    });
    const result = await streamModelInference({
      provider,
      frame: fakeFrame(),
      signal: new AbortController().signal,
      bus,
      layer: "actor",
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.tool).toBe("read_file");
    expect(result.finishReason).toBe("tool_calls");
  });

  it("accumulates reasoning deltas separately from text", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const provider = new FakeProvider({
      turns: [
        [
          { type: "reasoning-delta", text: "let me think " },
          { type: "text-delta", text: "answer" },
          { type: "reasoning-delta", text: "still thinking" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const result = await streamModelInference({
      provider,
      frame: fakeFrame(),
      signal: new AbortController().signal,
      bus,
      layer: "actor",
    });

    expect(result.text).toBe("answer");
    expect(result.reasoning).toBe("let me think still thinking");
  });

  it("propagates AbortError when signal aborts mid-stream", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const ac = new AbortController();
    const provider = new FakeProvider({
      turns: [
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
      ],
    });

    await expect(
      streamModelInference({
        provider,
        frame: fakeFrame(),
        signal: ac.signal,
        bus,
        layer: "actor",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("isAbortError recognises AbortError instances", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(isAbortError(e)).toBe(true);
    expect(isAbortError(new Error("normal"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it("toProviderError preserves the underlying message", () => {
    const inner = new Error("provider 500");
    const err = toProviderError(inner);
    expect(err.kind).toBe("provider_failed");
    expect(err.message).toBe("provider 500");
    expect(err.cause).toBe(inner);
  });
});
