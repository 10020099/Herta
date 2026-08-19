import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Where the bundle manifest lands. Under out/ (gitignored, and what
 * electron-builder packages — so `electron-builder.yml` EXCLUDES this one file
 * from `files:`), because writing anywhere else would need a .gitignore line
 * in both repos, and the public one is hand-owned.
 */
const BUNDLE_MANIFEST = resolve(__dirname, "out/bundle-manifest.json");

/**
 * Record exactly which modules rollup wrote into each bundle (audit BL26 →
 * THIRD-PARTY-NOTICES, 2026-08-16).
 *
 * The notices file has to describe what the INSTALLER ships, and the only
 * honest source for that is the bundler: package.json manifests over-count
 * (better-sqlite3 is a declared dependency and is tree-shaken clean out —
 * that is the packaging invariant CI greps for), and grepping the output for
 * package names under-counts (rollup keeps no names). `generateBundle` sees
 * the truth: every chunk's `modules` map, with `renderedLength` telling a
 * module that contributed code apart from one that survived only as an
 * empty graph node. Modules at 0 are dropped for the same reason CI's grep
 * exists — nothing of them ships.
 *
 * Runs on every build (dev included — harmless, ~ms) and merges per section,
 * so main / preload / renderer each overwrite only their own key.
 * `packages/gui/scripts/third-party-notices.mjs` turns this into the notices
 * file and, with `--check`, fails a release build whose notices are stale.
 */
function bundleManifest(section: "main" | "preload" | "renderer"): Plugin {
  return {
    name: "herta-bundle-manifest",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const [id, info] of Object.entries(output.modules)) {
          if (info.renderedLength > 0) modules.add(id);
        }
      }
      let manifest: Record<string, string[]> = {};
      if (existsSync(BUNDLE_MANIFEST)) {
        try {
          manifest = JSON.parse(readFileSync(BUNDLE_MANIFEST, "utf8"));
        } catch {
          manifest = {};
        }
      }
      manifest[section] = [...modules].sort();
      mkdirSync(dirname(BUNDLE_MANIFEST), { recursive: true });
      writeFileSync(BUNDLE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

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
    plugins: [bundleManifest("main")],
    build: {
      outDir: "out/main",
      rollupOptions: {
        output: {
          // __dirname polyfill for ESM main (type:module). Electron 43
          // ships Node 22 → import.meta.dirname is available.
          banner: "const __dirname = import.meta.dirname",
        },
      },
    },
  },
  preload: {
    plugins: [bundleManifest("preload")],
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
    plugins: [react(), bundleManifest("renderer")],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
