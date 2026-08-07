import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isBackendThinking,
  readAppSettings,
  writeAppSettings,
} from "./app-settings.js";

describe("app-settings", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const mk = (): string => {
    dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    return dir;
  };

  it("returns {} for a missing file", async () => {
    expect(await readAppSettings(mk())).toEqual({});
  });

  it("write then read round-trips", async () => {
    const ws = mk();
    await writeAppSettings(ws, { dream: { enabled: false } });
    expect(await readAppSettings(ws)).toEqual({ dream: { enabled: false } });
  });

  it("returns {} for corrupt JSON", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(join(ws, ".herta", "settings.json"), "{ not json", "utf-8");
    expect(await readAppSettings(ws)).toEqual({});
  });

  it("returns {} for a malformed nested dream field", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ dream: 5 }),
      "utf-8",
    );
    expect(await readAppSettings(ws)).toEqual({});
  });

  it("backend.thinking round-trips", async () => {
    const ws = mk();
    await writeAppSettings(ws, { backend: { thinking: "low" } });
    expect(await readAppSettings(ws)).toEqual({ backend: { thinking: "low" } });
  });

  it("returns {} for a malformed nested backend field", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ backend: "max" }),
      "utf-8",
    );
    expect(await readAppSettings(ws)).toEqual({});
  });

  it("isBackendThinking accepts the three tiers and rejects everything else", () => {
    expect(isBackendThinking("low")).toBe(true);
    expect(isBackendThinking("high")).toBe(true);
    expect(isBackendThinking("max")).toBe(true);
    // A hand-edited settings.json can hold anything — off-enum values must
    // fall back to the default rather than reach the API.
    expect(isBackendThinking("medium")).toBe(false);
    expect(isBackendThinking("off")).toBe(false);
    expect(isBackendThinking("")).toBe(false);
    expect(isBackendThinking(undefined)).toBe(false);
    expect(isBackendThinking(5)).toBe(false);
  });

  it("read + merge + write preserves unrelated keys (the handler pattern)", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ dream: { enabled: true }, other: 42 }),
      "utf-8",
    );
    const s = await readAppSettings(ws);
    await writeAppSettings(ws, { ...s, dream: { ...s.dream, enabled: false } });
    const out = (await readAppSettings(ws)) as Record<string, unknown>;
    expect(out.other).toBe(42);
    expect((out.dream as { enabled: boolean }).enabled).toBe(false);
  });
});
