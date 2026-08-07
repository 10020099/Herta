import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  // Main + preload BUNDLE their entire dependency graph (packaging strategy,
  // 2026-07-06): the former externalizeDepsPlugin left @herta/* as runtime
  // requires, which would force the installer to ship a pnpm node_modules
  // tree. Bundling makes out/ self-contained — and with the workspace libs
  // marked sideEffects:false, rollup tree-shakes the only native-dependency
  // branch (knowledge's SqliteKnowledgeStore → better-sqlite3, unreferenced
  // since the lore tools were removed) clean out of the bundle: the packaged
  // app ships NO node_modules and NO native modules. electron + node
  // builtins stay external automatically.
  main: {
    build: { outDir: "out/main" },
  },
  preload: {
    build: {
      outDir: "out/preload",
      // CJS, explicitly (audit T3.6): the package is type:module, so
      // electron-vite would emit the preload as ESM (index.mjs) — and a
      // SANDBOXED renderer only loads CJS preload scripts; the .mjs preload
      // silently fails to attach and window.herta comes up undefined. The
      // preload bundles self-contained, so CJS costs nothing.
      rollupOptions: { output: { format: "cjs" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
