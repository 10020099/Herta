import { describe, expect, it } from "vitest";
import {
  DEVICE_STATE_VISUALS,
  errorEnvelope,
  initialDeviceVisual,
  stepDeviceVisual,
  successEnvelope,
} from "./device-visual-engine.js";

describe("device-visual-engine", () => {
  it("initializes at the given state's targets", () => {
    const anim = initialDeviceVisual("waitingApproval");
    const t = DEVICE_STATE_VISUALS.waitingApproval;
    expect(anim.color).toEqual([...t.color]);
    expect(anim.glow).toEqual([...t.glow]);
    expect(anim.intensity).toBe(t.intensity);
    expect(anim.flashKind).toBe("none");
  });

  it("converges the color stack toward a new state's targets", () => {
    const anim = initialDeviceVisual("idle");
    // ~2s of frames — far past the 0.35s ease constant.
    let u = stepDeviceVisual(anim, "waitingApproval", 1 / 60, false);
    for (let i = 0; i < 120; i++) {
      u = stepDeviceVisual(anim, "waitingApproval", 1 / 60, false);
    }
    const t = DEVICE_STATE_VISUALS.waitingApproval;
    expect(u.color[0]).toBeCloseTo(t.color[0], 2);
    expect(u.color[1]).toBeCloseTo(t.color[1], 2);
    expect(u.color[2]).toBeCloseTo(t.color[2], 2);
    expect(u.spill).toBeCloseTo(t.spill, 2);
    // The amber LED is genuinely amber — red channel dominates blue,
    // the exact inversion of the idle blue it started from.
    expect(u.color[0]).toBeGreaterThan(u.color[2]);
  });

  it("breathes: intensity oscillates around the target over a cycle", () => {
    const anim = initialDeviceVisual("idle");
    const samples: number[] = [];
    for (let i = 0; i < 180; i++) {
      samples.push(stepDeviceVisual(anim, "idle", 1 / 60, false).intensity);
    }
    const t = DEVICE_STATE_VISUALS.idle;
    expect(Math.max(...samples)).toBeGreaterThan(t.intensity * 1.02);
    expect(Math.min(...samples)).toBeLessThan(t.intensity * 0.98);
  });

  it("entering succeeded fires the success flash, which decays away", () => {
    const anim = initialDeviceVisual("delegated");
    const first = stepDeviceVisual(anim, "succeeded", 1 / 60, false);
    expect(anim.flashKind).toBe("success");
    expect(first.flash).toBeGreaterThan(0);
    // Peak inside the rise window…
    let peak = first.flash;
    for (let i = 0; i < 30; i++) {
      peak = Math.max(
        peak,
        stepDeviceVisual(anim, "succeeded", 1 / 60, false).flash,
      );
    }
    expect(peak).toBeGreaterThan(0.8);
    // …and gone after the 1.5s envelope.
    for (let i = 0; i < 90; i++) {
      stepDeviceVisual(anim, "succeeded", 1 / 60, false);
    }
    expect(stepDeviceVisual(anim, "succeeded", 1 / 60, false).flash).toBe(0);
  });

  it("error envelope double-blinks: two humps with a dip between", () => {
    // Sample the pure envelope — hump, dip, hump, settle.
    expect(errorEnvelope(0.1)).toBeCloseTo(1, 5);
    expect(errorEnvelope(0.26)).toBeLessThan(0.2);
    expect(errorEnvelope(0.42)).toBeCloseTo(1, 5);
    expect(errorEnvelope(0.7)).toBeLessThan(0.2);
    expect(errorEnvelope(2)).toBe(0);
    // And the step wires it on the failed edge.
    const anim = initialDeviceVisual("runningCommand");
    stepDeviceVisual(anim, "failed", 1 / 60, false);
    expect(anim.flashKind).toBe("error");
  });

  it("success envelope rises then fully decays", () => {
    expect(successEnvelope(0)).toBe(0);
    expect(successEnvelope(0.3)).toBeCloseTo(1, 5);
    expect(successEnvelope(0.9)).toBeGreaterThan(0);
    expect(successEnvelope(0.9)).toBeLessThan(1);
    expect(successEnvelope(1.6)).toBe(0);
  });

  it("reduced motion pins the breath and skips flashes, but colors still ease", () => {
    const anim = initialDeviceVisual("idle");
    const intensities = new Set<number>();
    let u = stepDeviceVisual(anim, "succeeded", 1 / 60, true);
    expect(u.flash).toBe(0);
    expect(anim.flashKind).toBe("none");
    for (let i = 0; i < 120; i++) {
      u = stepDeviceVisual(anim, "succeeded", 1 / 60, true);
      intensities.add(Math.round(u.intensity * 1e6));
      expect(u.flash).toBe(0);
    }
    // No oscillation: intensity converges monotonically (few distinct values
    // early in the ease, then stable), never breath-modulated. The color
    // still landed on green.
    const t = DEVICE_STATE_VISUALS.succeeded;
    expect(u.intensity).toBeCloseTo(t.intensity, 2);
    expect(u.color[1]).toBeCloseTo(t.color[1], 2);
  });

  it("leaving a flash state clears the flash", () => {
    const anim = initialDeviceVisual("delegated");
    stepDeviceVisual(anim, "succeeded", 1 / 60, false);
    expect(anim.flashKind).toBe("success");
    const u = stepDeviceVisual(anim, "idle", 1 / 60, false);
    expect(anim.flashKind).toBe("none");
    expect(u.flash).toBe(0);
  });
});
