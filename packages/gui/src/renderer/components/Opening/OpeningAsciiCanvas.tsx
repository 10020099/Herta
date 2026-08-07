import { useEffect, useRef } from "react";
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
const DISSOLVE_START = 0.38;
/** Playback fraction at which the splash is fully transparent — connect screen
 *  fully shown, figure fully gone. */
const DISSOLVE_END = 0.94;

export interface OpeningAsciiCanvasProps {
  readonly data: SegmentData;
  /** Fired once when the dissolve BEGINS (at DISSOLVE_START), passing the
   *  dissolve duration in ms — the [DISSOLVE_START, DISSOLVE_END] slice of
   *  wall-clock playback — so the overlay's opacity fade-out and the onDone
   *  unmount span the same window the figure dissolves over. */
  readonly onComplete: (dissolveMs: number) => void;
}

/**
 * Plays a single opening segment once on a Canvas via requestAnimationFrame
 * (ported from preview_video_ascii.html's draw loop, made one-shot). When the
 * 2D context is unavailable (jsdom / headless), it falls back to a timer so
 * the opening sequence still completes.
 */
export function OpeningAsciiCanvas(
  props: OpeningAsciiCanvasProps,
): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onCompleteRef = useRef(props.onComplete);
  onCompleteRef.current = props.onComplete;

  useEffect(() => {
    const data = props.data;
    const duration = data.frameCount / data.fps;
    const wallDurationMs = (duration / RENDER_OPTIONS.playbackRate) * 1000;
    const dissolveMs = (DISSOLVE_END - DISSOLVE_START) * wallDurationMs;
    let raf = 0;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      onCompleteRef.current(dissolveMs);
    };
    // Instant completion for a splash whose timeline expired while the
    // window was hidden: zero-duration dissolve, straight to the workbench.
    const finishInstant = (): void => {
      if (done) return;
      done = true;
      onCompleteRef.current(0);
    };

    const canvas = canvasRef.current;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas ? canvas.getContext("2d") : null;
    } catch {
      ctx = null;
    }

    if (canvas === null || ctx === null) {
      fallbackTimer = setTimeout(
        finish,
        Math.ceil(DISSOLVE_START * wallDurationMs),
      );
      return () => {
        if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      };
    }

    const drawCtx = ctx;
    const frameBytes = decodeBase64ToBytes(data.framesBase64);
    // Night mode (2026-07-13): the splash follows the stamped theme — light
    // ink on a dark veil over the dark shell. Resolved ONCE at mount: the
    // index.html early stamp (localStorage hint) lands before React, so a
    // cold dark start reads correctly; a mid-splash flip isn't reachable
    // (Settings can't open under the overlay).
    const dark = document.documentElement.dataset.theme === "dark";
    // Per-layer ink styles + a per-cell layer lookup, resolved once for the
    // segment (the cell layout / layer ranges are fixed across frames).
    const layerStyles = resolveLayerStyles(data.layers, dark);
    const cellLayerNames = buildCellLayerNames(data.cells.length, data.layers);
    // Per-cell loop invariants (seed floors, flip interval, phase offset),
    // resolved once — the hot loop below runs ~8.5k cells per rAF frame
    // while the app is still bootstrapping (M-opening-1).
    const timings = precomputeCellTimings(data.cells);
    let startMs: number | null = null;
    // Frozen-clock skip (user 2026-07-14): rAF freezes while the window is
    // minimized but the wall clock keeps running. A frame gap this large
    // means the window was hidden — and if the resumed frame lands past the
    // dissolve point, the splash's moment has already passed.
    const GAP_SKIP_MS = 1000;
    const mountMs = performance.now();
    let lastFrameMs: number | null = null;

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (timeMs: number): void => {
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
        drawCtx.clearRect(
          0,
          0,
          canvas.clientWidth || window.innerWidth,
          canvas.clientHeight || window.innerHeight,
        );
        finishInstant();
        return;
      }
      if (startMs === null) startMs = timeMs;
      const elapsed = ((timeMs - startMs) / 1000) * RENDER_OPTIONS.playbackRate;
      const videoTime = Math.min(elapsed, duration);
      const framePosition = videoTime * data.fps;

      const p = duration > 0 ? videoTime / duration : 1;
      // outPortion 0: the figure does NOT shrink back on its own — it holds full
      // and dissolves via the overlay's opacity fade-out, in lockstep with the
      // white backdrop going transparent (the unified [38%, 94%] dissolve).
      const reveal = revealEnvelope(p, RENDER_OPTIONS.revealInPortion, 0);
      const veil = backdropVeil(p);

      const viewW = canvas.clientWidth || window.innerWidth;
      const viewH = canvas.clientHeight || window.innerHeight;
      drawCtx.clearRect(0, 0, viewW, viewH);
      // The veil matches the shell surface it dissolves into (dark: --shell's
      // 13,17,22; light: white) so the fade-out is seamless in both themes.
      drawCtx.fillStyle = dark
        ? `rgba(13, 17, 22, ${veil})`
        : `rgba(255, 255, 255, ${veil})`;
      drawCtx.fillRect(0, 0, viewW, viewH);

      const scale = Math.min(viewW / data.width, viewH / data.height);
      const offsetX = (viewW - data.width * scale) / 2;
      const offsetY = (viewH - data.height * scale) / 2;

      drawCtx.textAlign = "center";
      drawCtx.textBaseline = "middle";

      // Canvas state caches: `ctx.font =` re-parses a CSS font string on
      // every assignment, and the loop used to build + assign it twice per
      // cell. Quantizing the size to 0.1px (imperceptible; the one deliberate
      // approximation of M-opening-1) makes consecutive same-layer cells
      // share the string, so most assignments become no-op skips.
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

        const font = `${Math.round(fontSize * 10) / 10}px ${RENDER_OPTIONS.fontFamily}`;
        if (font !== lastFont) {
          drawCtx.font = font;
          lastFont = font;
        }
        if (style.foreground !== lastFill) {
          drawCtx.fillStyle = style.foreground;
          lastFill = style.foreground;
        }
        const ca = baseAlpha * state.currentAlpha;
        if (state.currentSymbol && ca > 0.001) {
          drawCtx.globalAlpha = ca;
          drawCtx.fillText(state.currentSymbol, x, y);
        }
        const na = baseAlpha * state.nextAlpha;
        if (state.nextSymbol && na > 0.001) {
          drawCtx.globalAlpha = na;
          drawCtx.fillText(state.nextSymbol, x, y);
        }
      }

      drawCtx.globalAlpha = 1;
      // Begin the dissolve at DISSOLVE_START (finish() is single-fire), but KEEP
      // drawing so the figure keeps animating as the overlay's opacity fades it
      // out — the splash unmounts at DISSOLVE_END (onDone), before the last frame.
      if (elapsed >= duration * DISSOLVE_START) finish();
      if (elapsed >= duration) return;
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      window.removeEventListener("resize", resize);
    };
  }, [props.data]);

  return <canvas ref={canvasRef} className="opening-ascii-canvas" />;
}
