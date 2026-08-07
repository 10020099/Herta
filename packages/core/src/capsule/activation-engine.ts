import type { ContextCapsule } from "../types/capsule.js";
import { evaluateActivation } from "./activation.js";
import { allocateBudget } from "./budget-allocator.js";
import { type ResolvedCapsule, resolveConflicts } from "./conflict-resolver.js";
import { estimateTokens } from "./estimate-tokens.js";
import type { Evidence, PromptTrace, TraceEntry } from "./types.js";

export interface ActivateOpts {
  capsules: ReadonlyArray<ContextCapsule>;
  evidence: Evidence;
  now: () => Date;
}

export interface ActivationOutput {
  kept: ResolvedCapsule[];
  trace: PromptTrace;
}

export function activate(opts: ActivateOpts): ActivationOutput {
  const evaluated: ResolvedCapsule[] = [];
  const inactive: ResolvedCapsule[] = [];
  for (const capsule of opts.capsules) {
    const decision = evaluateActivation(capsule, opts.evidence);
    if (decision.active) evaluated.push({ capsule, decision });
    else inactive.push({ capsule, decision });
  }
  const conflictResult = resolveConflicts(evaluated);
  const allocation = allocateBudget(conflictResult.kept);
  const toEntry = (
    r: ResolvedCapsule,
    reasonOverride?: string,
  ): TraceEntry => ({
    capsuleId: r.capsule.id,
    type: r.capsule.type,
    insertionLayer: r.capsule.insertionLayer,
    priority: r.capsule.priority,
    tokensEstimated: estimateTokens(r.capsule.content),
    reason: reasonOverride ?? r.decision.reason,
  });
  const trace: PromptTrace = {
    ts: opts.now().toISOString(),
    activated: allocation.kept.map((r) => toEntry(r)),
    suppressed: [
      ...inactive.map((r) => toEntry(r)),
      ...conflictResult.suppressed.map((r) =>
        toEntry(r, `suppressed by conflict-group "${r.capsule.conflictGroup}"`),
      ),
      ...allocation.dropped.map((r) =>
        toEntry(r, "dropped: token budget exceeded"),
      ),
    ],
    budgets: allocation.budgets,
  };
  return { kept: allocation.kept, trace };
}
