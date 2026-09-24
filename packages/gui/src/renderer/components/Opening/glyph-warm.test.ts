import { describe, expect, it, vi } from "vitest";
import {
  OPENING_GLYPHS,
  openingGlyphSizes,
  RENDER_OPTIONS,
} from "./ascii-renderer.js";
import { warmOpeningGlyphs } from "./glyph-warm.js";

describe("warmOpeningGlyphs (M-opening-2)", () => {
  it("hands the worker it spawns the draw loop's sizes for this window, its font and every symbol", () => {
    const postMessage = vi.fn();
    warmOpeningGlyphs(() => ({ postMessage }) as unknown as Worker);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const sizes = openingGlyphSizes(window.innerWidth, window.innerHeight);
    expect(sizes.length).toBeGreaterThan(0);
    expect(postMessage).toHaveBeenCalledWith({
      sizes,
      fontFamily: RENDER_OPTIONS.fontFamily,
      glyphs: OPENING_GLYPHS,
    });
  });

  it("is a quiet no-op where no worker can start", () => {
    expect(() => warmOpeningGlyphs(() => null)).not.toThrow();
    expect(() =>
      warmOpeningGlyphs(() => {
        throw new Error("refused by the CSP");
      }),
    ).not.toThrow();
    // jsdom has neither Worker nor OffscreenCanvas: the default spawn declines.
    expect(() => warmOpeningGlyphs()).not.toThrow();
  });
});
