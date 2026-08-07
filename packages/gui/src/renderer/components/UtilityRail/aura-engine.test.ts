import { describe, expect, it } from "vitest";
import {
  AURA_ENERGY_FLOOR,
  deriveAuraState,
  displayAuraState,
  getAuraUniformTarget,
  resolveAura,
} from "./aura-engine.js";

describe("deriveAuraState", () => {
  it("no session → disconnected", () => {
    expect(deriveAuraState({ sessionId: null, status: "idle" })).toBe(
      "disconnected",
    );
    expect(deriveAuraState({ sessionId: null, status: "speaking" })).toBe(
      "disconnected",
    );
  });
  it("active session, speaking → speaking", () => {
    expect(deriveAuraState({ sessionId: "s", status: "speaking" })).toBe(
      "speaking",
    );
  });
  it("active session, idle/thinking → listening", () => {
    expect(deriveAuraState({ sessionId: "s", status: "idle" })).toBe(
      "listening",
    );
    expect(deriveAuraState({ sessionId: "s", status: "thinking" })).toBe(
      "listening",
    );
  });
});

describe("displayAuraState", () => {
  it("a playing voice clip forces speaking (audio-only cue, e.g. easter egg)", () => {
    // idle session, but a clip is playing → speaking.
    expect(displayAuraState({ sessionId: "s", status: "idle" }, true)).toBe(
      "speaking",
    );
  });
  it("no voice + idle → listening (unchanged)", () => {
    expect(displayAuraState({ sessionId: "s", status: "idle" }, false)).toBe(
      "listening",
    );
  });
  it("text-driven speaking stays speaking regardless of voice", () => {
    expect(
      displayAuraState({ sessionId: "s", status: "speaking" }, false),
    ).toBe("speaking");
  });
  it("no session stays disconnected even while a clip plays", () => {
    expect(displayAuraState({ sessionId: null, status: "idle" }, true)).toBe(
      "disconnected",
    );
  });
});

describe("resolveAura", () => {
  it("normal motion passes state + energy through", () => {
    expect(resolveAura("speaking", false, 0.8)).toEqual({
      state: "speaking",
      energy: 0.8,
    });
  });
  it("reduced motion pins listening + floors energy (no flutter)", () => {
    const r = resolveAura("speaking", true, 0.9);
    expect(r.state).toBe("listening");
    expect(r.energy).toBe(AURA_ENERGY_FLOOR);
  });
});

describe("getAuraUniformTarget", () => {
  it("speaking amplitude grows with energy", () => {
    const lo = getAuraUniformTarget("speaking", 0.1, 0);
    const hi = getAuraUniformTarget("speaking", 0.9, 0);
    expect(hi.amplitude).toBeGreaterThan(lo.amplitude);
  });
  it("listening brightness stays within its pulse range", () => {
    const u = getAuraUniformTarget("listening", 0, 0.35);
    expect(u.brightness).toBeGreaterThanOrEqual(1.5);
    expect(u.brightness).toBeLessThanOrEqual(2.0);
  });
  it("disconnected is calm (low speed)", () => {
    expect(getAuraUniformTarget("disconnected", 0, 0).speed).toBeLessThan(
      getAuraUniformTarget("speaking", 0.5, 0).speed,
    );
  });

  // Tide-wave mapping (glass-wave direction, 2026-07-05): amplitude IS the
  // crest height, so the resting states must stay near-flat.
  it("disconnected rests as a nearly flat waterline", () => {
    expect(getAuraUniformTarget("disconnected", 0, 0).amplitude).toBeLessThan(
      0.1,
    );
  });
  it("listening amplitude breathes within the hairline band", () => {
    const flat = getAuraUniformTarget("listening", 0, 0).amplitude; // pulse=0
    const peak = getAuraUniformTarget("listening", 0, 0.8).amplitude; // pulse=1
    expect(flat).toBeCloseTo(0.112, 3);
    expect(peak).toBeCloseTo(0.192, 3);
  });
  it("speaking crest height spans well above the listening band", () => {
    expect(getAuraUniformTarget("speaking", 1, 0).amplitude).toBeGreaterThan(
      1.0,
    );
  });
});
