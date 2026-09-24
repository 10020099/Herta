import {
  alphaFromStrength,
  BASE_LAYER_STYLE,
  backdropVeil,
  buildCellLayerNames,
  decodeBase64ToBytes,
  fontSizeFromStrength,
  getInterpolatedBrightness,
  getStrength,
  getSymbolState,
  precomputeCellTimings,
  quantizeGlyphSize,
  RENDER_OPTIONS,
  resolveLayerStyles,
  revealEnvelope,
  type SegmentData,
} from "./ascii-renderer.js";

/** Playback fraction at which the splash begins dissolving: the figure AND the
 *  white backdrop fade out together (carried by the overlay's opacity) over
 *  [DISSOLVE_START, DISSOLVE_END], revealing the connect screen — so both are
 *  gone exactly as it is fully shown. The figure holds on white before this.
 *  Adopted via the inline tuner (user 2026-06-20). */
export const DISSOLVE_START = 0.38;
/** Playback fraction at which the splash is fully transparent — connect screen
 *  fully shown, figure fully gone. */
export const DISSOLVE_END = 0.94;

/** A segment's wall-clock playback length and its dissolve slice, in ms. */
export function openingTimeline(data: SegmentData): {
  readonly wallDurationMs: number;
  readonly dissolveMs: number;
} {
  const duration = data.frameCount / data.fps;
  const wallDurationMs = (duration / RENDER_OPTIONS.playbackRate) * 1000;
  return {
    wallDurationMs,
    dissolveMs: (DISSOLVE_END - DISSOLVE_START) * wallDurationMs,
  };
}

/** The 2D context the opening draws with: a DOM canvas's on the main thread,
 *  an OffscreenCanvas's on the draw worker. */
export type OpeningContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/** The veil at `alpha`. It matches the shell surface it dissolves into
 *  (dark: --shell's 13,17,22; light: white), so the fade-out is seamless in
 *  both themes. */
function veilFill(dark: boolean, alpha: number): string {
  return dark ? `rgba(13, 17, 22, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
}

/**
 * Size the surface and paint what the first frame opens on, the veil at
 * playback 0 (opaque), before the segment has loaded. The draw worker does
 * this as soon as it holds the canvas: the first draw creates the canvas's
 * GPU context (~85 ms on a cold start), and this way it happens in the
 * load's shadow, not in front of the first frame.
 */
export function paintOpeningCover(
  surface: { width: number; height: number },
  ctx: OpeningContext,
  dark: boolean,
  width: number,
  height: number,
  dpr: number,
): void {
  surface.width = Math.floor(width * dpr);
  surface.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = veilFill(dark, backdropVeil(0));
  ctx.fillRect(0, 0, width, height);
}

export interface OpeningPlayerEvents {
  /** The dissolve begins; its duration in ms (the [DISSOLVE_START,
   *  DISSOLVE_END] slice of playback). Fired once. */
  readonly onDissolve: (dissolveMs: number) => void;
  /** The timeline expired while the frames were frozen (a hidden window):
   *  the canvas is wiped and the opening completes with no dissolve. Fired
   *  once, instead of `onDissolve`. */
  readonly onInstant: () => void;
}

export interface OpeningPlayer {
  /** Size the drawing surface for a `width`×`height` CSS-px view at `dpr`. */
  resize(width: number, height: number, dpr: number): void;
  /** Draw the frame for animation-frame time `timeMs`. False once playback
   *  is over: the host stops asking for frames. */
  frame(timeMs: number): boolean;
}

/**
 * One play of a segment on a 2D context — the whole draw loop, with no idea
 * which thread it runs on (ported from preview_video_ascii.html's draw loop,
 * made one-shot). The host owns the animation frames and the view size: the
 * draw worker (`opening-draw.worker.ts`) on a transferred canvas, or the main
 * thread when no worker can start. `surface` is the canvas `ctx` draws on
 * (its backing size is set here). `mountMs` is the host's clock at start, in
 * the same time base as the frame times it will pass.
 */
export function createOpeningPlayer(
  surface: { width: number; height: number },
  ctx: OpeningContext,
  data: SegmentData,
  dark: boolean,
  events: OpeningPlayerEvents,
  mountMs: number,
): OpeningPlayer {
  const duration = data.frameCount / data.fps;
  const { dissolveMs } = openingTimeline(data);
  const frameBytes = decodeBase64ToBytes(data.framesBase64);
  // Night mode (2026-07-13): the splash follows the stamped theme — light
  // ink on a dark veil over the dark shell. The host resolves it ONCE at
  // mount: the index.html early stamp (localStorage hint) lands before
  // React, so a cold dark start reads correctly; a mid-splash flip isn't
  // reachable (Settings can't open under the overlay).
  //
  // Per-layer ink styles + a per-cell layer lookup, resolved once for the
  // segment (the cell layout / layer ranges are fixed across frames).
  const layerStyles = resolveLayerStyles(data.layers, dark);
  const cellLayerNames = buildCellLayerNames(data.cells.length, data.layers);
  // Per-cell loop invariants (seed floors, flip interval, phase offset),
  // resolved once — the hot loop below runs ~3k–9k cells per frame while
  // the app is still bootstrapping (M-opening-1).
  const timings = precomputeCellTimings(data.cells);
  // Frozen-clock skip (user 2026-07-14): animation frames freeze while the
  // window is minimized but the wall clock keeps running. A frame gap this
  // large means the window was hidden — and if the resumed frame lands past
  // the dissolve point, the splash's moment has already passed.
  const GAP_SKIP_MS = 1000;
  let startMs: number | null = null;
  let lastFrameMs: number | null = null;
  let done = false;
  let viewW = 0;
  let viewH = 0;

  return {
    resize(width, height, dpr) {
      viewW = width;
      viewH = height;
      surface.width = Math.floor(width * dpr);
      surface.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    frame(timeMs) {
      // Restored after the timeline expired while hidden (user 2026-07-14):
      // painting the resumed frame would show ONE full-hold figure and then
      // run the whole multi-second dissolve — a ghost splash minutes later.
      // Detect the frozen-clock gap (vs the previous frame, or vs MOUNT when
      // the first frame never ran) landing at/past the dissolve point, wipe
      // the canvas, and complete instantly instead.
      const gapMs = timeMs - (lastFrameMs ?? mountMs);
      lastFrameMs = timeMs;
      const wouldElapse =
        ((timeMs - (startMs ?? timeMs - gapMs)) / 1000) *
        RENDER_OPTIONS.playbackRate;
      if (gapMs > GAP_SKIP_MS && wouldElapse >= duration * DISSOLVE_START) {
        ctx.clearRect(0, 0, viewW, viewH);
        if (!done) {
          done = true;
          events.onInstant();
        }
        return false;
      }
      if (startMs === null) startMs = timeMs;
      const elapsed = ((timeMs - startMs) / 1000) * RENDER_OPTIONS.playbackRate;
      const videoTime = Math.min(elapsed, duration);
      const framePosition = videoTime * data.fps;

      const p = duration > 0 ? videoTime / duration : 1;
      // outPortion 0: the figure does NOT shrink back on its own — it holds
      // full and dissolves via the overlay's opacity fade-out, in lockstep
      // with the white backdrop going transparent (the unified [38%, 94%]
      // dissolve).
      const reveal = revealEnvelope(p, RENDER_OPTIONS.revealInPortion, 0);
      const veil = backdropVeil(p);

      ctx.clearRect(0, 0, viewW, viewH);
      ctx.fillStyle = veilFill(dark, veil);
      ctx.fillRect(0, 0, viewW, viewH);

      const scale = Math.min(viewW / data.width, viewH / data.height);
      const offsetX = (viewW - data.width * scale) / 2;
      const offsetY = (viewH - data.height * scale) / 2;

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Canvas state caches: `ctx.font =` re-parses a CSS font string on
      // every assignment, so an unchanged string is skipped. The size is
      // quantized to GLYPH_SIZE_STEP_PX (the deliberate approximation of
      // M-opening-1, coarsened by M-opening-2): the step bounds how many
      // (symbol, size) pairs the text engine must rasterize.
      let lastFont = "";
      let lastFill = "";

      for (let i = 0; i < data.cells.length; i += 1) {
        const cell = data.cells[i];
        if (cell === undefined) continue;
        const style =
          layerStyles[cellLayerNames[i] ?? "default"] ??
          layerStyles.default ??
          BASE_LAYER_STYLE;
        const brightness = getInterpolatedBrightness(
          frameBytes,
          data.activeCount,
          data.frameCount,
          i,
          framePosition,
        );
        // Strength once per cell (it's a Math.pow), alpha BEFORE font math:
        // a fully transparent cell exits without paying for font sizing or
        // symbol hashing. Same drawn set as before — the per-symbol alpha
        // guards and the minDrawFontSize skip are unchanged.
        const strength = getStrength(brightness, style.gamma);
        const baseAlpha = alphaFromStrength(strength, style, reveal);
        if (baseAlpha <= 0.001) continue;
        const fontSize =
          fontSizeFromStrength(strength, cell[2], style, reveal) * scale;
        if (fontSize < style.minDrawFontSize) continue;

        const x = offsetX + cell[0] * scale;
        const y = offsetY + cell[1] * scale;
        const state = getSymbolState(
          timings.seedXs[i] ?? 0,
          timings.seedYs[i] ?? 0,
          brightness,
          elapsed,
          timings.intervals[i],
          timings.phaseOffsets[i],
        );

        const font = `${quantizeGlyphSize(fontSize)}px ${RENDER_OPTIONS.fontFamily}`;
        if (font !== lastFont) {
          ctx.font = font;
          lastFont = font;
        }
        if (style.foreground !== lastFill) {
          ctx.fillStyle = style.foreground;
          lastFill = style.foreground;
        }
        const ca = baseAlpha * state.currentAlpha;
        if (state.currentSymbol && ca > 0.001) {
          ctx.globalAlpha = ca;
          ctx.fillText(state.currentSymbol, x, y);
        }
        const na = baseAlpha * state.nextAlpha;
        if (state.nextSymbol && na > 0.001) {
          ctx.globalAlpha = na;
          ctx.fillText(state.nextSymbol, x, y);
        }
      }

      ctx.globalAlpha = 1;
      // Begin the dissolve at DISSOLVE_START (single-fire), but KEEP drawing
      // so the figure keeps animating as the overlay's opacity fades it out —
      // the splash unmounts at DISSOLVE_END (onDone), before the last frame.
      if (elapsed >= duration * DISSOLVE_START && !done) {
        done = true;
        events.onDissolve(dissolveMs);
      }
      return elapsed < duration;
    },
  };
}
