import { describe, expect, it } from "vitest";
import { detectTestRun, isTestCommand } from "./test-detector.js";

describe("isTestCommand", () => {
  it("detects pnpm test", () => {
    expect(isTestCommand(["pnpm", "test"])).toBe(true);
  });

  it("detects npm test", () => {
    expect(isTestCommand(["npm", "test"])).toBe(true);
  });

  it("detects pnpm run test", () => {
    expect(isTestCommand(["pnpm", "run", "test"])).toBe(true);
  });

  it("detects npm run test", () => {
    expect(isTestCommand(["npm", "run", "test"])).toBe(true);
  });

  it("detects pytest with no args", () => {
    expect(isTestCommand(["pytest"])).toBe(true);
  });

  it("detects pytest with args", () => {
    expect(isTestCommand(["pytest", "-x", "tests/foo.py"])).toBe(true);
  });

  it("detects cargo test", () => {
    expect(isTestCommand(["cargo", "test"])).toBe(true);
  });

  it("detects cargo test with flags", () => {
    expect(isTestCommand(["cargo", "test", "--release"])).toBe(true);
  });

  it("detects go test", () => {
    expect(isTestCommand(["go", "test", "./..."])).toBe(true);
  });

  it("rejects pnpm run lint", () => {
    expect(isTestCommand(["pnpm", "run", "lint"])).toBe(false);
  });

  it("rejects pnpm install", () => {
    expect(isTestCommand(["pnpm", "install"])).toBe(false);
  });

  it("rejects cargo build", () => {
    expect(isTestCommand(["cargo", "build"])).toBe(false);
  });

  it("rejects cargo check", () => {
    expect(isTestCommand(["cargo", "check"])).toBe(false);
  });

  it("rejects go build", () => {
    expect(isTestCommand(["go", "build"])).toBe(false);
  });

  it("rejects empty argv", () => {
    expect(isTestCommand([])).toBe(false);
  });

  it("rejects unrelated commands", () => {
    expect(isTestCommand(["echo", "hi"])).toBe(false);
    expect(isTestCommand(["git", "status"])).toBe(false);
  });
});

describe("detectTestRun", () => {
  it("returns passed for exit 0 on a test command", () => {
    const result = detectTestRun({
      argv: ["pnpm", "test"],
      exitCode: 0,
      durationMs: 1230,
      timedOut: false,
    });
    expect(result).not.toBeNull();
    expect(result?.command).toBe("pnpm test");
    expect(result?.status).toBe("passed");
    expect(result?.summary).toBe("exit 0, 1.23s");
  });

  it("returns failed for non-zero exit", () => {
    const result = detectTestRun({
      argv: ["pytest"],
      exitCode: 1,
      durationMs: 850,
      timedOut: false,
    });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBe("exit 1, 0.85s");
  });

  it("returns failed for null exit code (signal)", () => {
    const result = detectTestRun({
      argv: ["cargo", "test"],
      exitCode: null,
      durationMs: 500,
      timedOut: false,
    });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBe("exit null, 0.50s");
  });

  it("returns failed for timed-out runs", () => {
    const result = detectTestRun({
      argv: ["go", "test", "./..."],
      exitCode: null,
      durationMs: 120000,
      timedOut: true,
    });
    expect(result?.status).toBe("failed");
    expect(result?.summary).toBe("timed out, 120.00s");
    expect(result?.command).toBe("go test ./...");
  });

  it("returns null for non-test commands", () => {
    expect(
      detectTestRun({
        argv: ["echo", "hi"],
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
      }),
    ).toBeNull();
  });

  it("returns null for empty argv", () => {
    expect(
      detectTestRun({
        argv: [],
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
      }),
    ).toBeNull();
  });
});
