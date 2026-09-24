import {
  OPENING_GLYPHS,
  openingGlyphSizes,
  RENDER_OPTIONS,
} from "./ascii-renderer.js";
import type { GlyphWarmRequest } from "./glyph-warm.worker.js";

/** The bundled warm-up worker, or null where the platform has no `Worker`
 *  or `OffscreenCanvas` (jsdom). Vite emits the worker's entry as a chunk of
 *  its own from this exact expression; the CSP's `worker-src 'self'` admits
 *  it. */
function spawnBundledWorker(): Worker | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  return new Worker(new URL("./glyph-warm.worker.ts", import.meta.url), {
    type: "module",
  });
}

/**
 * Starts the opening's glyph warm-up (see `glyph-warm.worker.ts`) for this
 * window's size and device scale. Called once, first thing at boot, so the
 * worker has the few hundred milliseconds before the opening's first frame.
 * Performance only: when no worker can start, the opening draws exactly the
 * same, paying for each new glyph as it first meets it.
 */
export function warmOpeningGlyphs(
  spawnWorker: () => Worker | null = spawnBundledWorker,
): void {
  let worker: Worker | null;
  try {
    worker = spawnWorker();
  } catch {
    return;
  }
  if (worker === null) return;
  const request: GlyphWarmRequest = {
    sizes: openingGlyphSizes(window.innerWidth, window.innerHeight),
    fontFamily: RENDER_OPTIONS.fontFamily,
    glyphs: OPENING_GLYPHS,
  };
  worker.postMessage(request);
}
