import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { Conversation } from "./Conversation.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

/**
 * Counting passthrough over the timestamp formatter. It is the honest probe
 * for "did the row work run": `formatBubbleTime` is called once per timestamped
 * block by `renderBlock`, so its call count IS the number of bubble rows
 * rendered — and it was the top app-level cost in the send profile.
 *
 * Its own suite covers the formatting; this file only counts.
 */
const calls = { formatBubbleTime: 0 };
vi.mock("./format-time.js", async () => {
  const real =
    await vi.importActual<typeof import("./format-time.js")>(
      "./format-time.js",
    );
  return {
    ...real,
    formatBubbleTime: (...args: Parameters<typeof real.formatBubbleTime>) => {
      calls.formatBubbleTime += 1;
      return real.formatBubbleTime(...args);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  calls.formatBubbleTime = 0;
});

/** A record of `pairs` exchanges, every block timestamped so each one costs a
 *  formatter call. */
function longRecord(pairs: number) {
  const at = new Date("2026-07-30T04:00:00.000Z").toISOString();
  return Array.from({ length: pairs }, (_, i) => [
    { kind: "user" as const, text: `question ${i}`, at },
    {
      kind: "herta" as const,
      surface: "speech" as const,
      text: `answer ${i}`,
      at,
    },
  ]).flat();
}

function mount(pairs: number) {
  const mock = createMockHertaBridge();
  const view = renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <Conversation />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  act(() => {
    mock.emitReset({
      sessionId: "perf-session",
      workspaceRoot: "/r",
      record: longRecord(pairs),
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  });
  return { mock, view };
}

describe("Conversation — the row memo does not depend on turn state (2026-07-30)", () => {
  it("a send re-renders NO bubble rows", () => {
    // The bug: `rows` was one memo over both bubble and activity rows, so it
    // carried the activity groups' dependencies — status, turnStartedAt,
    // backendStartedAt, backendInFlight, backendActive, plan, canRewind. All of
    // those flip when a turn starts, so pressing send re-rendered every bubble
    // in the session (and again when the turn ended) — 40 rows here, ~100 in a
    // real long session, each one an Intl format, landing exactly on the send
    // animation's first frames.
    const { mock } = mount(20);
    expect(calls.formatBubbleTime).toBeGreaterThan(0); // the initial render
    const afterMount = calls.formatBubbleTime;

    // Turn starts: status idle → thinking, turnStartedAt set.
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(calls.formatBubbleTime).toBe(afterMount);

    // …and the backend goes to work: backendStartedAt / backendActive /
    // inFlight all move.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    expect(calls.formatBubbleTime).toBe(afterMount);

    // …and the turn ends, which flips status back and clears the anchors.
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(calls.formatBubbleTime).toBe(afterMount);
  });

  it("but a new block DOES render rows — the memo is not simply frozen", () => {
    // Without this the test above would pass just as well on a memo that never
    // recomputes, which would be a rendering bug rather than a fix.
    const { mock } = mount(20);
    const afterMount = calls.formatBubbleTime;
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "extra",
        block: {
          kind: "user",
          text: "one more",
          at: new Date("2026-07-30T04:10:00.000Z").toISOString(),
        },
      });
    });
    expect(calls.formatBubbleTime).toBeGreaterThan(afterMount);
    expect(screen.getByText("one more")).toBeInTheDocument();
  });

  it("the rewind control is hidden mid-turn, and back when the turn ends", () => {
    // The gate moved from a withheld prop (which is what put `status` in the
    // memo) to CSS plus the handler's own idle check. The affordance must still
    // come and go with the turn.
    const { mock, view } = mount(2);
    const flow = view.container.querySelector(
      ".conversation-flow",
    ) as HTMLElement;
    expect(view.container.querySelector(".message-rewind")).not.toBeNull();
    expect(flow.classList.contains("is-busy")).toBe(false);
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    // Still mounted (the row did not re-render) but not offered: the rule that
    // hides it keys on this class.
    expect(flow.classList.contains("is-busy")).toBe(true);
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(flow.classList.contains("is-busy")).toBe(false);
  });

  it("a rewind click mid-turn is refused by the handler, not just by CSS", async () => {
    // CSS cannot be a guard — a stale hover, a keyboard activation, or a
    // future style change would walk straight past it into a truncation of the
    // turn that is still running.
    const { mock, view } = mount(2);
    const btn = view.container.querySelector(
      ".message-rewind",
    ) as HTMLButtonElement;
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    btn.click();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.calls.rewindLastTurn).toBe(0);
  });
});
