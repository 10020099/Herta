import type { ContextCapsule } from "../types/capsule.js";
import type { Evidence } from "./types.js";

export interface ActivationDecision {
  active: boolean;
  reason: string;
}

// MVP scope: only userMessagePatterns is evaluated. Other signal arrays
// (pathPatterns, taskTypes, etc.) are accepted on the capsule schema but
// unused. They become evidence in later phases.
export function evaluateActivation(
  capsule: ContextCapsule,
  evidence: Evidence,
): ActivationDecision {
  if (!capsule.enabled) return { active: false, reason: "disabled" };
  const a = capsule.activation;
  switch (a.mode) {
    case "always":
      return { active: true, reason: "always-on" };
    case "any":
      return matchAny(a, evidence);
    case "all":
      return matchAll(a, evidence);
    case "not":
      return invert(matchAny(a, evidence));
    case "scored":
      return { active: false, reason: "scored mode not supported in MVP" };
  }
}

function matchAny(
  a: ContextCapsule["activation"],
  evidence: Evidence,
): ActivationDecision {
  const patterns = a.userMessagePatterns ?? [];
  for (const p of patterns) {
    if (evidence.userMessage.includes(p)) {
      return { active: true, reason: `userMessagePatterns matched: ${p}` };
    }
  }
  return { active: false, reason: "no userMessagePatterns matched" };
}

function matchAll(
  a: ContextCapsule["activation"],
  evidence: Evidence,
): ActivationDecision {
  const patterns = a.userMessagePatterns ?? [];
  if (patterns.length === 0) {
    return { active: false, reason: "all mode with no patterns" };
  }
  for (const p of patterns) {
    if (!evidence.userMessage.includes(p)) {
      return { active: false, reason: `userMessagePatterns missing: ${p}` };
    }
  }
  return { active: true, reason: "all userMessagePatterns matched" };
}

function invert(decision: ActivationDecision): ActivationDecision {
  return { active: !decision.active, reason: `not: ${decision.reason}` };
}
