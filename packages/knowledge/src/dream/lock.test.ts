import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDreamLock } from "./lock.js";

describe("acquireDreamLock", () => {
  let dir: string;
  const NOW = Date.parse("2026-07-03T00:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("acquires, blocks a second acquirer, and frees on release", () => {
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    // Held by our own (live) pid with a fresh timestamp → busy.
    expect(acquireDreamLock(dir, NOW)).toBeUndefined();
    lock?.release();
    expect(existsSync(join(dir, "pass.lock"))).toBe(false);
    const again = acquireDreamLock(dir, NOW);
    expect(again).toBeDefined();
    again?.release();
  });

  it("steals a lock whose holder pid is absent (crashed holder)", () => {
    // No pid field → provably not a live holder → stolen.
    writeFileSync(
      join(dir, "pass.lock"),
      JSON.stringify({ at: new Date(NOW).toISOString() }),
      "utf8",
    );
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    lock?.release();
  });

  it("steals an ancient lock even when its pid is alive (pid recycling)", () => {
    writeFileSync(
      join(dir, "pass.lock"),
      JSON.stringify({ pid: process.pid, at: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    lock?.release();
  });

  it("steals a corrupt (unparseable) lock", () => {
    writeFileSync(join(dir, "pass.lock"), "not json", "utf8");
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    lock?.release();
  });

  it("keeps a fresh lock held by a live pid", () => {
    writeFileSync(
      join(dir, "pass.lock"),
      JSON.stringify({
        pid: process.pid,
        at: new Date(NOW - 60_000).toISOString(),
      }),
      "utf8",
    );
    expect(acquireDreamLock(dir, NOW)).toBeUndefined();
  });

  it("releasing twice is safe", () => {
    const lock = acquireDreamLock(dir, NOW);
    lock?.release();
    expect(() => lock?.release()).not.toThrow();
  });
});
