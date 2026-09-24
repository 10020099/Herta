import {
  BASE_LAYER_STYLE,
  OPENING_GLYPHS,
  openingGlyphSizes,
  RENDER_OPTIONS,
  resolveLayerStyles,
} from "./ascii-renderer.js";
import type {
  GlyphSheetReply,
  GlyphSheetRequest,
} from "./glyph-sheet.worker.js";
import type { OpeningSheet } from "./glyph-sheet-layout.js";

/** The bundled sheet worker, or null where the platform has no `Worker` or
 *  `OffscreenCanvas` (jsdom). Vite emits the worker's entry as a chunk of
 *  its own from this exact expression; the CSP's `worker-src 'self'` admits
 *  it. */
function spawnBundledWorker(): Worker | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  return new Worker(new URL("./glyph-sheet.worker.ts", import.meta.url), {
    type: "module",
  });
}

let pending: Promise<OpeningSheet | null> | null = null;

/**
 * Starts drawing the opening's glyph sheet (see `glyph-sheet.worker.ts`) for
 * this window's size, device scale and theme. Called once, first thing at
 * boot. Never throws: where no worker can start, the sheet is null and the
 * opening draws text, as before.
 */
export function startOpeningGlyphSheet(
  spawnWorker: () => Worker | null = spawnBundledWorker,
): void {
  if (pending !== null) return;
  let worker: Worker | null;
  try {
    worker = spawnWorker();
  } catch {
    worker = null;
  }
  if (worker === null) {
    pending = Promise.resolve(null);
    return;
  }
  const w = worker;
  // The theme the opening will draw in: index.html stamps it before any
  // script runs, and the opening reads the same stamp at mount.
  const dark = document.documentElement.dataset.theme === "dark";
  const request: GlyphSheetRequest = {
    sizes: openingGlyphSizes(window.innerWidth, window.innerHeight),
    fontFamily: RENDER_OPTIONS.fontFamily,
    glyphs: OPENING_GLYPHS,
    dpr: window.devicePixelRatio || 1,
    ink:
      resolveLayerStyles(undefined, dark).default?.foreground ??
      BASE_LAYER_STYLE.foreground,
  };
  pending = new Promise<OpeningSheet | null>((resolve) => {
    const settle = (sheet: OpeningSheet | null): void => {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
      resolve(sheet);
    };
    w.onmessage = (event: MessageEvent<GlyphSheetReply>) =>
      settle(event.data.type === "sheet" ? event.data.sheet : null);
    w.onerror = () => settle(null);
    w.onmessageerror = () => settle(null);
  });
  w.postMessage(request);
}

/** The sheet once drawn; null when there is none (never started, no
 *  worker, nothing to draw, or released). */
export function openingGlyphSheet(): Promise<OpeningSheet | null> {
  return pending ?? Promise.resolve(null);
}

/** The opening is over: free the sheet's pixels. */
export function releaseOpeningGlyphSheet(): void {
  const held = pending;
  pending = Promise.resolve(null);
  void held?.then((sheet) => sheet?.bitmap.close());
}

/** Test hook. */
export function resetOpeningGlyphSheetForTest(): void {
  pending = null;
}
