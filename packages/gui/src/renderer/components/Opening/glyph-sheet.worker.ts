import {
  layoutOpeningSheet,
  OPENING_SHEET_WIDTH,
  type OpeningSheet,
} from "./glyph-sheet-layout.js";

/**
 * The opening's glyph sheet, drawn on its own thread while the app boots
 * (M-opening-4, 2026-09-25; before that this thread only measured the
 * glyphs to warm the text cache, M-opening-2).
 *
 * Every symbol at every size the draw loop can ask for, at the device's
 * pixel scale, in the ink: ~2.6k glyphs at a 1440-wide window. On a cold
 * start that took 0.3 s alone and ~0.55 s alongside the boot, much of it the
 * thread's own start-up (its fonts, its canvas), which is why `main.tsx`
 * starts it before the app's modules load; split across workers it barely
 * got faster. The canvas is a software one: the text is rasterized on this
 * thread, not in the GPU process the opening's frames queue for. The sheet
 * goes back as an ImageBitmap; the thread closes.
 */

/** What to draw. `sizes` are CSS px; `dpr` scales them to the device. */
export interface GlyphSheetRequest {
  readonly sizes: readonly number[];
  readonly fontFamily: string;
  readonly glyphs: string;
  readonly dpr: number;
  readonly ink: string;
}

/** The drawn sheet, or `none` when there is none to draw (too large, or no
 *  2D context) — the opening then draws text, as before. */
export type GlyphSheetReply =
  | { readonly type: "sheet"; readonly sheet: OpeningSheet }
  | { readonly type: "none" };

function reply(message: GlyphSheetReply, transfer: Transferable[] = []): void {
  // The options form: this file is typed against the window's globals, and a
  // worker's postMessage takes `{ transfer }` just the same.
  postMessage(message, { transfer });
  close();
}

addEventListener("message", (event: MessageEvent<GlyphSheetRequest>) => {
  const { sizes, fontFamily, glyphs, dpr, ink } = event.data;
  const layout = layoutOpeningSheet(sizes, dpr, glyphs.length);
  if (layout === null) {
    reply({ type: "none" });
    return;
  }
  const canvas = new OffscreenCanvas(OPENING_SHEET_WIDTH, layout.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) {
    reply({ type: "none" });
    return;
  }
  // The loop's own alignment, so a glyph sits in its cell as fillText would
  // place it at the cell's centre.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ink;
  for (const entry of layout.entries) {
    ctx.font = `${entry.px * dpr}px ${fontFamily}`;
    for (let i = 0; i < glyphs.length; i += 1) {
      const x = entry.pos[2 * i] ?? 0;
      const y = entry.pos[2 * i + 1] ?? 0;
      ctx.fillText(glyphs[i] as string, x + entry.w / 2, y + entry.h / 2);
    }
  }
  const bitmap = canvas.transferToImageBitmap();
  reply(
    {
      type: "sheet",
      sheet: { bitmap, dpr, ink, glyphs, entries: layout.entries },
    },
    [bitmap],
  );
});
