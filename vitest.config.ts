import { defineConfig } from "vitest/config";

// Workspace vitest config — uses Vitest 3's `projects` feature so each
// package can opt into its own environment / setup files. Without
// projects, every test would inherit the root environment (node) and
// the root setupFiles (none), which breaks React/jsdom tests in
// packages/gui.
export default defineConfig({
  test: {
    projects: [
      // Default project: all non-gui packages. Node environment,
      // .test.ts only (no React / JSX in these packages).
      {
        test: {
          name: "node",
          include: [
            "packages/{app-server,cli,core,herta,knowledge,memory,providers,tools}/src/**/*.test.ts",
          ],
          passWithNoTests: true,
        },
      },
      // GUI project: defers to packages/gui/vitest.config.ts which
      // sets environment: "jsdom" + setupFiles for jest-dom matchers.
      // Picks up .test.ts and .test.tsx.
      "packages/gui",
      // Website project (audit T3.7): the demo lives OUTSIDE packages/, so
      // it was invisible to the runner and any test written there silently
      // never ran (masked by passWithNoTests). No tests exist yet; this
      // entry makes future ones actually execute.
      {
        test: {
          name: "website",
          include: ["website/src/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
    passWithNoTests: true,
  },
});
