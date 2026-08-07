import { describe, expect, it } from "vitest";
import { MockWritable } from "../testing/mock-streams.js";
import { parseArgs, parseThinking } from "./config.js";

describe("parseArgs", () => {
  it("--resume with empty string value falls back to latest", () => {
    expect(parseArgs(["--resume", ""]).resume).toBe("latest");
    expect(parseArgs(["--resume="]).resume).toBe("latest");
  });

  it("--lang absent parses as undefined (main defaults to zh)", () => {
    expect(parseArgs([]).lang).toBeUndefined();
  });

  it("--lang space-separated and = forms parse the raw value", () => {
    expect(parseArgs(["--lang", "en"]).lang).toBe("en");
    expect(parseArgs(["--lang", "zh"]).lang).toBe("zh");
    expect(parseArgs(["--lang=en"]).lang).toBe("en");
    expect(parseArgs(["--lang=zh"]).lang).toBe("zh");
  });

  it("--lang passes invalid values through raw for main to reject", () => {
    expect(parseArgs(["--lang", "de"]).lang).toBe("de");
    expect(parseArgs(["--lang=de"]).lang).toBe("de");
  });

  it("bare --lang (or --lang before another flag) parses as empty string", () => {
    expect(parseArgs(["--lang"]).lang).toBe("");
    expect(parseArgs(["--lang", "--resume"]).lang).toBe("");
    expect(parseArgs(["--lang="]).lang).toBe("");
  });

  it("--lang combines with --resume without consuming its value", () => {
    const parsed = parseArgs(["--lang", "en", "--resume", "abc"]);
    expect(parsed.lang).toBe("en");
    expect(parsed.resume).toBe("abc");
  });
});

describe("parseThinking", () => {
  it("returns undefined for undefined input", () => {
    const stderr = new MockWritable();
    expect(parseThinking(undefined, stderr)).toBeUndefined();
    expect(stderr.full()).toBe("");
  });

  it("'false' / 'off' return false", () => {
    const stderr = new MockWritable();
    expect(parseThinking("false", stderr)).toBe(false);
    expect(parseThinking("off", stderr)).toBe(false);
    expect(stderr.full()).toBe("");
  });

  it("'low' / 'high' / 'max' pass through", () => {
    const stderr = new MockWritable();
    expect(parseThinking("low", stderr)).toBe("low");
    expect(parseThinking("high", stderr)).toBe("high");
    expect(parseThinking("max", stderr)).toBe("max");
    expect(stderr.full()).toBe("");
  });

  it("invalid value returns undefined and writes warning", () => {
    const stderr = new MockWritable();
    expect(parseThinking("yes", stderr)).toBeUndefined();
    expect(stderr.full()).toContain("yes");
    expect(stderr.full()).toContain("invalid thinking level");
  });

  it("'medium' still warns — it was never a valid v4 value ('low' became real in the 2026-07-31 flash update)", () => {
    const stderr = new MockWritable();
    expect(parseThinking("medium", stderr)).toBeUndefined();
    expect(stderr.full()).toContain("invalid thinking level");
  });

  it("empty string treated as invalid", () => {
    const stderr = new MockWritable();
    expect(parseThinking("", stderr)).toBeUndefined();
    expect(stderr.full()).toContain("invalid thinking level");
  });
});
