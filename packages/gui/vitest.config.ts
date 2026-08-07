import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/setup-tests.ts"],
    globals: false,
    include: ["src/renderer/**/*.test.{ts,tsx}", "src/main/**/*.test.{ts,tsx}"],
  },
});
