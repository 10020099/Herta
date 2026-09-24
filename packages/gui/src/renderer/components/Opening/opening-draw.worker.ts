import type { SegmentData } from "./ascii-renderer.js";
import {
  createOpeningPlayer,
  type OpeningPlayer,
  paintOpeningCover,
} from "./opening-player.js";

/**
 * The opening's draw loop on its own thread (M-opening-3, 2026-09-25).
 *
 * The opening plays while the app boots, and on the main thread each frame
 * (3k–6.5k glyph draws plus the canvas commit) waited behind the boot's own
 * tasks, and they behind it. Here the same player (`opening-player.ts`) draws
 * on the canvas the component transferred, from this thread's own animation
 * frames; its commits go straight to the compositor.
 *
 * Two steps, so the start-up overlaps the segment's load: `prepare` (sent as
 * the splash mounts) takes the canvas and paints the first frame's opaque
 * veil, which creates its GPU context; `play` (sent once the segment has
 * loaded) starts the frames. The main thread hears of three
 * moments only: the first frame, the dissolve, and an instant finish.
 */

interface View {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Main → worker. Sizes are CSS px. */
export type OpeningDrawRequest =
  | ({
      readonly type: "prepare";
      readonly canvas: OffscreenCanvas;
      readonly dark: boolean;
    } & View)
  | { readonly type: "play"; readonly data: SegmentData }
  | ({ readonly type: "resize" } & View);

/** Worker → main. `first-frame` carries when it was committed, in epoch ms;
 *  `no-context`: the canvas gave no 2D context (the main thread plays the
 *  opening instead). */
export type OpeningDrawEvent =
  | { readonly type: "first-frame"; readonly atEpochMs: number }
  | { readonly type: "dissolve"; readonly dissolveMs: number }
  | { readonly type: "instant" }
  | { readonly type: "no-context" };

function send(event: OpeningDrawEvent): void {
  postMessage(event);
}

let surface: {
  readonly canvas: OffscreenCanvas;
  readonly ctx: OffscreenCanvasRenderingContext2D;
  readonly dark: boolean;
} | null = null;
let view: View = { width: 0, height: 0, dpr: 1 };
let player: OpeningPlayer | null = null;

function play(data: SegmentData): void {
  if (surface === null || player !== null) return;
  const started = createOpeningPlayer(
    surface.canvas,
    surface.ctx,
    data,
    surface.dark,
    {
      onDissolve: (dissolveMs) => send({ type: "dissolve", dissolveMs }),
      onInstant: () => send({ type: "instant" }),
    },
    performance.now(),
  );
  player = started;
  started.resize(view.width, view.height, view.dpr);
  let first = true;
  const step = (timeMs: number): void => {
    const more = started.frame(timeMs);
    if (first) {
      first = false;
      send({
        type: "first-frame",
        atEpochMs: performance.timeOrigin + performance.now(),
      });
    }
    if (more) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

addEventListener("message", (event: MessageEvent<OpeningDrawRequest>) => {
  const request = event.data;
  if (request.type === "resize") {
    view = request;
    if (player !== null) player.resize(view.width, view.height, view.dpr);
    else if (surface !== null) {
      paintOpeningCover(
        surface.canvas,
        surface.ctx,
        surface.dark,
        view.width,
        view.height,
        view.dpr,
      );
    }
  } else if (request.type === "prepare") {
    if (surface !== null) return;
    const ctx = request.canvas.getContext("2d");
    if (ctx === null) {
      send({ type: "no-context" });
      return;
    }
    surface = { canvas: request.canvas, ctx, dark: request.dark };
    view = request;
    paintOpeningCover(
      request.canvas,
      ctx,
      request.dark,
      view.width,
      view.height,
      view.dpr,
    );
  } else {
    play(request.data);
  }
});
