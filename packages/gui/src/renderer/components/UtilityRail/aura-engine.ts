import type { SessionStatus } from "../../store/session-store.js";

export type AgentAuraState = "disconnected" | "listening" | "speaking";

interface AuraProfile {
  readonly speed: number;
  readonly floor: number;
  readonly scale: number;
  readonly frequency: number;
  readonly brightness: number;
}

/** Locked profiles from the reference (speech-visual-UX `agentStates`).
 *  Amplitude is no longer profile-driven — the tide-wave mapping in
 *  getAuraUniformTarget owns it (glass-wave direction, 2026-07-05). */
export const agentStates: Record<AgentAuraState, AuraProfile> = {
  disconnected: {
    speed: 10,
    floor: 0.08,
    scale: 0.23,
    frequency: 0.4,
    brightness: 1.0,
  },
  listening: {
    speed: 20,
    floor: 0.26,
    scale: 0.3,
    frequency: 0.7,
    brightness: 1.3,
  },
  speaking: {
    speed: 70,
    floor: 0.32,
    scale: 0.3,
    frequency: 1.25,
    brightness: 1.35,
  },
};

/** Resting energy floor used in disconnected and under reduced motion. */
export const AURA_ENERGY_FLOOR = 0.08;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

/** 0→1→0 triangle over `duration`. */
export function mirrorPulse(time: number, duration: number): number {
  const progress = (time % duration) / duration;
  return progress < 0.5 ? progress * 2 : (1 - progress) * 2;
}

/** Map HERTA session state → aura state. */
export function deriveAuraState(s: {
  readonly sessionId: string | null;
  readonly status: SessionStatus;
}): AgentAuraState {
  if (s.sessionId === null) return "disconnected";
  if (s.status === "speaking") return "speaking";
  return "listening"; // idle | thinking
}

/**
 * The aura state to DISPLAY. A currently-playing voice clip forces "speaking" so
 * audio-only cues (e.g. the easter egg, which streams no text) animate the card
 * the same way streamed speech does — except with no session, where it stays
 * "disconnected". Otherwise the session-derived state.
 */
export function displayAuraState(
  s: {
    readonly sessionId: string | null;
    readonly status: SessionStatus;
  },
  voicePlaying: boolean,
): AgentAuraState {
  const base = deriveAuraState(s);
  if (base === "disconnected") return base;
  return voicePlaying ? "speaking" : base;
}

/** Reduced motion: pin the calm listening breath + floor energy (no flutter). */
export function resolveAura(
  state: AgentAuraState,
  reduced: boolean,
  energy: number,
): { state: AgentAuraState; energy: number } {
  if (reduced) return { state: "listening", energy: AURA_ENERGY_FLOOR };
  return { state, energy };
}

export interface AuraUniformTarget {
  readonly speed: number;
  readonly scale: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly brightness: number;
}

/** Target uniforms for the current state + energy + time.
 *
 * Amplitude follows the tide-wave mapping (glass-wave direction, 2026-07-05):
 * uAmplitude sets the crest height of the shader's wave curve (and its warp
 * turbulence), so the waterline rests nearly flat while disconnected, breathes
 * as a hairline while listening, and punches per word while speaking. The
 * study's 0.8 tide geometry factor is folded into these constants. See
 * reference_UX_design/glass-wave-study/. */
export function getAuraUniformTarget(
  state: AgentAuraState,
  energy: number,
  time: number,
): AuraUniformTarget {
  const profile = agentStates[state];
  if (state === "disconnected") {
    return {
      speed: profile.speed,
      scale: profile.scale,
      amplitude: 0.064,
      frequency: profile.frequency,
      brightness: profile.brightness,
    };
  }
  if (state === "listening") {
    return {
      speed: profile.speed,
      scale: profile.scale,
      amplitude: 0.112 + 0.08 * mirrorPulse(time, 1.6),
      frequency: profile.frequency,
      brightness: lerp(1.5, 2.0, mirrorPulse(time, 0.7)),
    };
  }
  const breath = Math.sin(time * 2.1);
  const breathDepth = 0.028 + 0.018 * energy;
  return {
    speed: 145,
    scale: 0.3 + breathDepth * breath,
    amplitude: 0.28 + 0.92 * energy,
    frequency: profile.frequency,
    brightness: 1.5,
  };
}
