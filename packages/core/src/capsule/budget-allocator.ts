import type { CapsuleInsertionLayer } from "../types/capsule.js";
import type { ResolvedCapsule } from "./conflict-resolver.js";
import { estimateTokens } from "./estimate-tokens.js";
import type { BudgetSummary } from "./types.js";

const LAYER_CAPS: Partial<Record<CapsuleInsertionLayer, number>> = {
  retrieved_lore: 800,
};

export interface AllocationResult {
  kept: ResolvedCapsule[];
  dropped: ResolvedCapsule[];
  budgets: BudgetSummary[];
}

export function allocateBudget(input: ResolvedCapsule[]): AllocationResult {
  const byLayer = new Map<CapsuleInsertionLayer, ResolvedCapsule[]>();
  for (const r of input) {
    const k = r.capsule.insertionLayer;
    byLayer.set(k, [...(byLayer.get(k) ?? []), r]);
  }
  const kept: ResolvedCapsule[] = [];
  const dropped: ResolvedCapsule[] = [];
  const budgets: BudgetSummary[] = [];
  for (const [layer, members] of byLayer) {
    const cap = LAYER_CAPS[layer] ?? null;
    members.sort(
      (a, b) =>
        b.capsule.priority - a.capsule.priority ||
        a.capsule.id.localeCompare(b.capsule.id),
    );
    let used = 0;
    let droppedHere = 0;
    for (const r of members) {
      const tokens = estimateTokens(r.capsule.content);
      if (cap !== null && used + tokens > cap) {
        if (r.capsule.tokenBudget.overflow === "must_keep") {
          kept.push(r);
          used += tokens;
        } else {
          dropped.push(r);
          droppedHere += 1;
        }
      } else {
        kept.push(r);
        used += tokens;
      }
    }
    budgets.push({
      insertionLayer: layer,
      tokensUsed: used,
      tokensCap: cap,
      droppedCount: droppedHere,
    });
  }
  return { kept, dropped, budgets };
}
