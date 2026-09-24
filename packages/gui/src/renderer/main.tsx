import "./styles/reference-ux.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { warmOpeningGlyphs } from "./components/Opening/glyph-warm.js";

// Before React: the warm-up worker needs the time until the opening's first frame.
warmOpeningGlyphs();

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root element not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
