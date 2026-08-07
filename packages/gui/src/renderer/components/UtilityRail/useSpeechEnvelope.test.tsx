import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { useSpeechEnvelope } from "./useSpeechEnvelope.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockAsyncRaf(): void {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(
    (cb) => setTimeout(() => cb(0), 16) as unknown as number,
  );
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  });
}

function setup() {
  const mock = createMockHertaBridge();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HertaBridgeProvider bridge={mock.bridge}>{children}</HertaBridgeProvider>
  );
  const rendered = renderHook(() => useSpeechEnvelope(), { wrapper });
  act(() => {
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    // Deltas only flow inside a turn on the real wire (the store drops
    // out-of-turn deltas — the phantom-bubble guard).
    mock.emitTurn({ kind: "started", turnId: "t-env" });
  });
  return { mock, rendered };
}

const delta = (text: string) =>
  ({
    kind: "agent",
    event: { type: "assistant.delta", layer: "actor", text } as never,
  }) as const;

describe("useSpeechEnvelope", () => {
  it("accumulates kicks as the revealed text grows; drain resets", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setup();
    act(() => {
      mock.emitAgent(delta("你好"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 6); // let the reveal pace catch up
    });
    const k = rendered.result.current.drainKicks();
    expect(k.count).toBeGreaterThanOrEqual(2);
    // Drained: a second drain with no growth is empty.
    const k2 = rendered.result.current.drainKicks();
    expect(k2.count).toBe(0);
    expect(k2.punctuation).toBeNull();
  });

  it("classifies hard and soft punctuation from the last revealed char", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setup();
    act(() => {
      mock.emitAgent(delta("好。"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 6);
    });
    expect(rendered.result.current.drainKicks().punctuation).toBe("hard");
    act(() => {
      mock.emitAgent(delta("嗯，"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 8);
    });
    expect(rendered.result.current.drainKicks().punctuation).toBe("soft");
  });

  /** Activate the hook in a specific interaction language. */
  function setupLang(lang: "zh" | "en") {
    const mock = createMockHertaBridge();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <HertaBridgeProvider bridge={mock.bridge}>{children}</HertaBridgeProvider>
    );
    const rendered = renderHook(() => useSpeechEnvelope(), { wrapper });
    act(() => {
      mock.emitReset({
        sessionId: `s-${lang}`,
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        lang,
      });
      mock.emitTurn({ kind: "started", turnId: `t-${lang}` });
    });
    return { mock, rendered };
  }

  it("classifies an EN sentence end (. ! ?) as a HARD breath in an EN session", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setupLang("en");
    act(() => {
      mock.emitAgent(delta("Done."));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 4);
    });
    // The wave settles where the sink's EN sentence breath pauses the text.
    expect(rendered.result.current.drainKicks().punctuation).toBe("hard");
  });

  it("does NOT treat an ASCII '.' as a hard breath in a zh session (byte-identity)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setupLang("zh");
    // A zh reply mentioning a version / path ends in ASCII "." — never a break.
    act(() => {
      mock.emitAgent(delta("看 v0."));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 8);
    });
    expect(rendered.result.current.drainKicks().punctuation).toBeNull();
  });

  it("keeps kicking from retryText during a retract (the shrink itself is silent)", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setup();
    act(() => {
      mock.emitAgent(delta("候选"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 6);
    });
    rendered.result.current.drainKicks(); // clear the candidate's kicks
    act(() => {
      mock.emitSpeech({ kind: "retract" });
    });
    act(() => {
      vi.advanceTimersByTime(16 * 6); // shrink window: no text growth
    });
    expect(rendered.result.current.drainKicks().count).toBe(0);
    // Retry deltas (buffered into retryText during the retract) kick again.
    act(() => {
      mock.emitAgent(delta("修订"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 2);
    });
    expect(rendered.result.current.drainKicks().count).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("a streaming code block produces zero kicks; surrounding prose kicks", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setup();
    act(() => {
      mock.emitAgent(delta("看这个：\n"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 10);
    });
    expect(rendered.result.current.drainKicks().count).toBeGreaterThan(0);
    // The fence + code stream in: no speakable growth → no kicks.
    act(() => {
      mock.emitAgent(delta("```ts\nconst x = 1;\n```\n"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 30);
    });
    expect(rendered.result.current.drainKicks().count).toBe(0);
    // Prose after the fence kicks again.
    act(() => {
      mock.emitAgent(delta("就这样。"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 10);
    });
    expect(rendered.result.current.drainKicks().count).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("a session reset does not produce negative or spurious kicks", () => {
    vi.useFakeTimers();
    mockAsyncRaf();
    const { mock, rendered } = setup();
    act(() => {
      mock.emitAgent(delta("一些文本"));
    });
    act(() => {
      vi.advanceTimersByTime(16 * 8);
    });
    rendered.result.current.drainKicks();
    act(() => {
      mock.emitReset({
        sessionId: "s2",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(rendered.result.current.drainKicks().count).toBe(0);
  });
});
