/**
 * The opening's glyph warm-up, on its own thread (M-opening-2, 2026-09-25).
 *
 * The first draw of a (symbol, size) pair anywhere in the renderer costs
 * ~0.1 ms, most of it glyph metrics the text engine then keeps in a cache the
 * process shares. The opening's reveal meets ~2.4k new pairs in its first
 * half-second, at 70–100 ms a frame when it drew on the main thread. This
 * worker measures every pair while the app is still booting, so the reveal
 * finds most of them cached. Measured both ways: the main thread's draws got
 * cheaper, and since the draw moved to its own worker (M-opening-3) the hold
 * runs at 23 fps with this warm-up and 13 without. It shows nothing and
 * answers nothing: it closes when done.
 */

/** What to warm: the draw loop's sizes, font and symbols. */
export interface GlyphWarmRequest {
  readonly sizes: readonly number[];
  readonly fontFamily: string;
  readonly glyphs: string;
}

addEventListener("message", (event: MessageEvent<GlyphWarmRequest>) => {
  const { sizes, fontFamily, glyphs } = event.data;
  const ctx = new OffscreenCanvas(1, 1).getContext("2d");
  if (ctx !== null) {
    // Measuring is the expensive half of a first draw (the glyph metrics the
    // cache keeps), and it needs no drawing surface: a first fillText here
    // created a GPU context, 60–200 ms on a cold start. The CSS size, not
    // the device size: at a device scale of 2 that warmed the draws better.
    for (const px of sizes) {
      ctx.font = `${px}px ${fontFamily}`;
      for (const glyph of glyphs) ctx.measureText(glyph);
    }
  }
  close();
});
