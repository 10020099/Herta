import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GLYPH_SIZE_STEP_PX, type SegmentData } from "./ascii-renderer.js";
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

  it("draws every glyph at a GLYPH_SIZE_STEP_PX size (M-opening-2)", () => {
    const fonts: string[] = [];
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      get font(): string {
        return fonts.at(-1) ?? "";
      },
      set font(value: string) {
        fonts.push(value);
      },
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
    render(<OpeningAsciiCanvas data={stubSegment()} onComplete={() => {}} />);
    // Reveal 0 on the first frame draws nothing; 40 ms later the dark cell is in.
    act(() => pump(1000));
    act(() => pump(1040));
    expect(ctx.fillText).toHaveBeenCalled();
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      const px = Number.parseFloat(font);
      expect(px / GLYPH_SIZE_STEP_PX).toBe(Math.round(px / GLYPH_SIZE_STEP_PX));
    }
    getCtx.mockRestore();
    raf.mockRestore();
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

/** A stand-in for the draw worker: records what it is sent, and lets the
 *  test speak for it. */
class FakeWorker {
  readonly posted: unknown[] = [];
  readonly transfers: unknown[][] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push(message);
    this.transfers.push(transfer);
  }
  terminate(): void {
    this.terminated = true;
  }
  say(data: unknown): void {
    act(() => this.onmessage?.({ data } as MessageEvent));
  }
  fail(): void {
    act(() => this.onerror?.(new Event("error")));
  }
}

describe("OpeningAsciiCanvas on the draw worker (M-opening-3)", () => {
  const offscreen = { width: 0, height: 0 } as unknown as OffscreenCanvas;
  let transferred: HTMLCanvasElement[] = [];

  function setUp(initial: SegmentData | null = stubSegment()) {
    transferred = [];
    Object.defineProperty(
      HTMLCanvasElement.prototype,
      "transferControlToOffscreen",
      {
        configurable: true,
        value(this: HTMLCanvasElement) {
          transferred.push(this);
          return offscreen;
        },
      },
    );
    const getCtx = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    const worker = new FakeWorker();
    const onComplete = vi.fn();
    const onFirstFrame = vi.fn();
    const spawnWorker = () => worker as unknown as Worker;
    const view = (data: SegmentData | null) => (
      <OpeningAsciiCanvas
        data={data}
        onComplete={onComplete}
        onFirstFrame={onFirstFrame}
        spawnWorker={spawnWorker}
      />
    );
    const { unmount, container, rerender } = render(view(initial));
    const load = (data: SegmentData) => rerender(view(data));
    return {
      worker,
      onComplete,
      onFirstFrame,
      unmount,
      container,
      getCtx,
      load,
    };
  }

  const PREPARE = {
    type: "prepare",
    canvas: offscreen,
    dark: false,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };

  afterEach(() => {
    delete (
      HTMLCanvasElement.prototype as { transferControlToOffscreen?: unknown }
    ).transferControlToOffscreen;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hands the worker its canvas, theme and view size while the segment loads, then the segment — the main thread draws nothing", () => {
    const { worker, container, getCtx, load } = setUp(null);
    expect(transferred).toHaveLength(1);
    expect(container.querySelector("canvas")).toBe(transferred[0]);
    expect(worker.posted).toEqual([PREPARE]);
    expect(worker.transfers[0]).toEqual([offscreen]);
    load(stubSegment());
    expect(worker.posted).toEqual([
      PREPARE,
      { type: "play", data: stubSegment() },
    ]);
    // A re-render with the same segment plays nothing twice.
    load(stubSegment());
    expect(worker.posted).toHaveLength(2);
    expect(getCtx).not.toHaveBeenCalled();
  });

  it("passes on the worker's first frame (with its time) and dissolve, once each", () => {
    const { worker, onComplete, onFirstFrame } = setUp();
    worker.say({ type: "first-frame", atEpochMs: 1234.5 });
    worker.say({ type: "first-frame", atEpochMs: 9999 });
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(onFirstFrame).toHaveBeenCalledWith(1234.5);
    worker.say({ type: "dissolve", dissolveMs: 1234 });
    worker.say({ type: "dissolve", dissolveMs: 99 });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(1234);
  });

  it("an instant finish from the worker completes with no dissolve", () => {
    const { worker, onComplete } = setUp();
    worker.say({ type: "instant" });
    expect(onComplete).toHaveBeenCalledWith(0);
  });

  it("follows the window's size", () => {
    const { worker } = setUp();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(worker.posted[2]).toEqual({
      type: "resize",
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    });
  });

  it("terminates the worker and removes its canvas on unmount; late messages do nothing", () => {
    const { worker, onComplete, unmount, container } = setUp();
    const onmessage = worker.onmessage;
    unmount();
    expect(worker.terminated).toBe(true);
    expect(container.querySelector("canvas")).toBeNull();
    act(() =>
      onmessage?.({
        data: { type: "dissolve", dissolveMs: 5 },
      } as MessageEvent),
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["the worker errors", (w: FakeWorker) => w.fail()],
    [
      "the canvas gives the worker no 2D context",
      (w: FakeWorker) => w.say({ type: "no-context" }),
    ],
  ])("plays on the main thread, on a fresh canvas, when %s", (_what, failWith) => {
    const { worker, container, getCtx, onComplete } = setUp();
    getCtx.mockReturnValue(null);
    vi.useFakeTimers();
    failWith(worker);
    expect(worker.terminated).toBe(true);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas).not.toBe(transferred[0]);
    expect(getCtx).toHaveBeenCalledTimes(1);
    // No context here either (jsdom): the timer completes the sequence.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("a worker that fails while the segment loads leaves the play to the main thread", () => {
    const { worker, getCtx, load, container } = setUp(null);
    getCtx.mockReturnValue(null);
    worker.fail();
    expect(worker.terminated).toBe(true);
    expect(getCtx).not.toHaveBeenCalled();
    load(stubSegment());
    expect(getCtx).toHaveBeenCalledTimes(1);
    expect(worker.posted).toEqual([PREPARE]);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector("canvas")).not.toBe(transferred[0]);
  });

  it("once the dissolve has begun, a worker error hands nothing back", () => {
    const { worker, getCtx, container } = setUp();
    worker.say({ type: "dissolve", dissolveMs: 800 });
    worker.fail();
    expect(getCtx).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBe(transferred[0]);
  });

  it("falls back when no first frame comes while the window is visible — and waits while it is hidden", () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { worker, getCtx } = setUp();
    getCtx.mockReturnValue(null);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(worker.terminated).toBe(false);
    visibility.mockReturnValue("visible");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(worker.terminated).toBe(true);
    expect(getCtx).toHaveBeenCalledTimes(1);
  });

  it("the watchdog waits for the play: a slow segment load is not a slow worker", () => {
    vi.useFakeTimers();
    const { worker, load } = setUp(null);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(worker.terminated).toBe(false);
    load(stubSegment());
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(worker.terminated).toBe(true);
  });

  it("a first frame in time keeps the worker", () => {
    vi.useFakeTimers();
    const { worker, getCtx } = setUp();
    worker.say({ type: "first-frame", atEpochMs: 1 });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(worker.terminated).toBe(false);
    expect(getCtx).not.toHaveBeenCalled();
  });
});
