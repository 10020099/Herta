import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportProviderUsage } from "@herta/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installUsageLog } from "./usage-log.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const call = (n: number) => ({
  endpoint: "completion" as const,
  model: "deepseek-v4-pro",
  promptTokens: 1000 + n,
  completionTokens: n,
  cacheHitTokens: 960,
  cacheMissTokens: 40 + n,
});

describe("installUsageLog", () => {
  it("appends one JSON line per reported call, in order, numbers only — and stops when uninstalled", async () => {
    const file = join(dir, "nested", "usage.jsonl");
    const uninstall = installUsageLog(file);
    for (let n = 0; n < 5; n++) reportProviderUsage(call(n));
    await uninstall();
    reportProviderUsage(call(99)); // after uninstall: nobody is listening
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.completion)).toEqual([0, 1, 2, 3, 4]);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["at", "completion", "endpoint", "hit", "miss", "model", "prompt"].sort(),
    );
    expect(rows[0]).toMatchObject({
      endpoint: "completion",
      model: "deepseek-v4-pro",
      prompt: 1000,
      hit: 960,
      miss: 40,
    });
    expect(Number.isNaN(Date.parse(rows[0].at))).toBe(false);
  });

  it("the idle dream pass's calls say so — `source: dream` — and the session's own carry no source (dream review 2026-09-22, finding 4)", async () => {
    const file = join(dir, "usage.jsonl");
    const uninstall = installUsageLog(file);
    reportProviderUsage(call(1));
    reportProviderUsage({ ...call(2), endpoint: "chat", source: "dream" });
    await uninstall();
    const rows = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0]).not.toHaveProperty("source");
    expect(rows[1]).toMatchObject({ endpoint: "chat", source: "dream" });
  });

  it("moves an oversized log aside once, at install, and starts a fresh one", async () => {
    const file = join(dir, "usage.jsonl");
    writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1));
    const uninstall = installUsageLog(file);
    reportProviderUsage(call(1));
    await uninstall();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("an unwritable path costs the call nothing", async () => {
    // A FILE where the directory should be: mkdir and every append fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const uninstall = installUsageLog(join(blocker, "usage.jsonl"));
    expect(() => reportProviderUsage(call(1))).not.toThrow();
    await expect(uninstall()).resolves.toBeUndefined();
  });
});
