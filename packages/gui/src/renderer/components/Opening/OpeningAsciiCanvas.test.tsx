import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SegmentData } from "./ascii-renderer.js";
import { OpeningAsciiCanvas } from "./OpeningAsciiCanvas.js";

function stubSegment(): SegmentData {
  // 1 cell, 2 frames -> duration 2/24 ≈ 0.083s.
  const bytes = new Uint8Array([10, 200]);
  const framesBase64 = btoa(String.fromCharCode(...bytes));
  return {
    type: "adaptive-ascii-video-segment-v1",
    width: 10,
    height: 10,
    fps: 24,
    frameCount: 2,
    activeCount: 1,
    cells: [[5, 5, 6]],
    framesBase64,
  };
}

describe("OpeningAsciiCanvas", () => {
  afterEach(() => vi.useRealTimers());

  it("calls onComplete once after the segment duration (jsdom has no 2D ctx)", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    render(<OpeningAsciiCanvas data={stubSegment()} onComplete={onComplete} />);
    // jsdom canvas getContext('2d') throws/returns null -> timer fallback of
    // ceil(duration*1000) = 84ms.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("renders a canvas element", () => {
    vi.useFakeTimers();
    const { container } = render(
      <OpeningAsciiCanvas data={stubSegment()} onComplete={() => {}} />,
    );
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("completes INSTANTLY (0ms dissolve, no paint) when restored after the timeline expired while hidden (2026-07-14)", () => {
    // Real draw-loop path: stub a minimal 2D context (jsdom has none) and a
    // controllable rAF queue with explicit timestamps.
    const fillText = vi.fn();
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText,
      font: "",
      fillStyle: "",
      globalAlpha: 1,
      textAlign: "",
      textBaseline: "",
    };
    const getCtx = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    let rafCbs: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        rafCbs.push(cb);
        return rafCbs.length;
      });
    const pump = (t: number): void => {
      const cbs = rafCbs;
      rafCbs = [];
      for (const cb of cbs) cb(t);
    };
    const onComplete = vi.fn();
    render(<OpeningAsciiCanvas data={stubSegment()} onComplete={onComplete} />);
    // First frame starts the timeline and paints the backdrop veil.
    act(() => pump(1000));
    expect(ctx.fillRect).toHaveBeenCalled();
    (ctx.fillRect as ReturnType<typeof vi.fn>).mockClear();
    fillText.mockClear();
    // The window was minimized: rAF frozen for a minute, timeline expired.
    act(() => pump(61_000));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(0); // instant — no dissolve fade
    // The resumed frame never paints (wiped, not drawn).
    expect(ctx.fillRect).not.toHaveBeenCalled();
    expect(fillText).not.toHaveBeenCalled();
    getCtx.mockRestore();
    raf.mockRestore();
  });
});
