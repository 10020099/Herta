import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";

/**
 * CPU side of the device LED shader (2026-07-12): per-state uniform targets
 * plus the frame step that eases the live uniforms toward them. This is what
 * the old CSS could not do — a state change MORPHS the whole color stack
 * (blue → amber over ~a third of a second) instead of snapping classes and
 * transitioning a drop-shadow around a permanently blue core. The success
 * flash and error double-blink keyframes become time envelopes here.
 * Pure functions + a mutable anim record, so the whole thing unit-tests
 * without GL; DeviceGlow's render loop is a thin uniform-upload shell.
 */

type Rgb = readonly [number, number, number];

export interface DeviceVisualTarget {
  /** Spill wash + glass disk tint. */
  readonly color: Rgb;
  /** Ring body + bloom halo. */
  readonly glow: Rgb;
  /** How far the white-hot core leans toward the state color. */
  readonly coreMix: number;
  /** Master gain before breath modulation. */
  readonly intensity: number;
  /** Spill wash strength. */
  readonly spill: number;
  /** Breathing rate; the working states breathe fast (mirrors the old
   *  1.3s devPulse vs 2.8s idle). */
  readonly breathHz: number;
  /** Breath modulation depth (fraction of intensity). */
  readonly breathDepth: number;
}

const BLUE: Rgb = [0.36, 0.55, 1.0];
const CYAN: Rgb = [0.45, 0.86, 1.0];

const WORKING: DeviceVisualTarget = {
  color: BLUE,
  glow: CYAN,
  coreMix: 0.3,
  intensity: 1.12,
  spill: 0.78,
  breathHz: 1 / 1.3,
  breathDepth: 0.12,
};

export const DEVICE_STATE_VISUALS: Record<
  BanzhuanDeviceState,
  DeviceVisualTarget
> = {
  idle: {
    color: BLUE,
    glow: CYAN,
    coreMix: 0.28,
    intensity: 0.92,
    spill: 0.6,
    breathHz: 1 / 2.8,
    breathDepth: 0.07,
  },
  delegated: WORKING,
  reading: WORKING,
  writing: WORKING,
  runningCommand: WORKING,
  verifying: WORKING,
  waitingApproval: {
    color: [1.0, 0.72, 0.38],
    glow: [1.0, 0.85, 0.5],
    coreMix: 0.5,
    intensity: 1.02,
    spill: 0.72,
    breathHz: 1 / 1.9,
    breathDepth: 0.1,
  },
  succeeded: {
    color: [0.42, 0.9, 0.6],
    glow: [0.6, 1.0, 0.72],
    coreMix: 0.5,
    intensity: 1.06,
    spill: 0.72,
    breathHz: 1 / 2.0,
    breathDepth: 0.07,
  },
  failed: {
    color: [0.94, 0.36, 0.32],
    glow: [1.0, 0.5, 0.44],
    coreMix: 0.55,
    intensity: 0.9,
    spill: 0.58,
    breathHz: 1 / 2.8,
    breathDepth: 0.04,
  },
};

/** Time constant of the state-change ease (63% of the way in ~0.35s). */
const COLOR_EASE_S = 0.35;

export interface DeviceVisualUniforms {
  readonly color: Rgb;
  readonly glow: Rgb;
  readonly coreMix: number;
  readonly intensity: number;
  readonly spill: number;
  readonly flash: number;
}

export interface DeviceVisualAnim {
  color: [number, number, number];
  glow: [number, number, number];
  coreMix: number;
  intensity: number;
  spill: number;
  breathHz: number;
  breathPhase: number;
  breathDepth: number;
  /** Last state seen, for flash edge detection. */
  state: BanzhuanDeviceState;
  flashKind: "none" | "success" | "error";
  flashClockS: number;
}

export function initialDeviceVisual(
  state: BanzhuanDeviceState = "idle",
): DeviceVisualAnim {
  const t = DEVICE_STATE_VISUALS[state];
  return {
    color: [...t.color],
    glow: [...t.glow],
    coreMix: t.coreMix,
    intensity: t.intensity,
    spill: t.spill,
    breathHz: t.breathHz,
    breathPhase: 0,
    breathDepth: t.breathDepth,
    state,
    flashKind: "none",
    flashClockS: 0,
  };
}

/** Mirrors the CSS devSuccess flash: fast rise, ~1.5s glide back down. */
export function successEnvelope(t: number): number {
  if (t < 0) return 0;
  if (t < 0.3) return t / 0.3;
  if (t < 1.5) return 1 - (t - 0.3) / 1.2;
  return 0;
}

/** Mirrors devError's double blink: two pulses inside the first ~0.6s,
 *  then the steady dim-red target carries the state on its own. */
export function errorEnvelope(t: number): number {
  const pulse = (center: number, halfWidth: number): number =>
    Math.max(0, 1 - Math.abs(t - center) / halfWidth);
  return Math.max(pulse(0.1, 0.12), pulse(0.42, 0.15));
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/**
 * Advance the live uniforms one frame toward `state`'s targets.
 * `reduced` (prefers-reduced-motion) pins the breath and skips flashes —
 * colors still ease so a state change reads, it just doesn't blink.
 */
export function stepDeviceVisual(
  anim: DeviceVisualAnim,
  state: BanzhuanDeviceState,
  dtS: number,
  reduced: boolean,
): DeviceVisualUniforms {
  if (state !== anim.state) {
    anim.state = state;
    if (!reduced && state === "succeeded") {
      anim.flashKind = "success";
      anim.flashClockS = 0;
    } else if (!reduced && state === "failed") {
      anim.flashKind = "error";
      anim.flashClockS = 0;
    } else {
      anim.flashKind = "none";
    }
  }

  const t = DEVICE_STATE_VISUALS[state];
  const k = 1 - Math.exp(-dtS / COLOR_EASE_S);
  for (let i = 0; i < 3; i++) {
    anim.color[i] = lerp(anim.color[i] ?? 0, t.color[i] ?? 0, k);
    anim.glow[i] = lerp(anim.glow[i] ?? 0, t.glow[i] ?? 0, k);
  }
  anim.coreMix = lerp(anim.coreMix, t.coreMix, k);
  anim.intensity = lerp(anim.intensity, t.intensity, k);
  anim.spill = lerp(anim.spill, t.spill, k);
  anim.breathHz = lerp(anim.breathHz, t.breathHz, k);
  anim.breathDepth = lerp(anim.breathDepth, t.breathDepth, k);

  anim.breathPhase += dtS * 2 * Math.PI * anim.breathHz;
  const breath = reduced
    ? 1
    : 1 + Math.sin(anim.breathPhase) * anim.breathDepth;

  anim.flashClockS += dtS;
  const flash = reduced
    ? 0
    : anim.flashKind === "success"
      ? successEnvelope(anim.flashClockS)
      : anim.flashKind === "error"
        ? errorEnvelope(anim.flashClockS)
        : 0;

  return {
    color: anim.color,
    glow: anim.glow,
    coreMix: anim.coreMix,
    intensity: anim.intensity * breath,
    spill: anim.spill,
    flash,
  };
}
