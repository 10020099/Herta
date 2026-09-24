import "./styles/reference-ux.css";
import { startOpeningGlyphSheet } from "./components/Opening/glyph-sheet.js";

// The entry is kept tiny on purpose (M-opening-4). The opening waits for its
// glyph sheet, and most of the sheet's time is its worker's own start-up.
// Starting it here — before the app's modules are fetched, compiled and
// run — lays that start-up over the app's own load instead of after it.
startOpeningGlyphSheet();

void import("./boot.js");
