import type { ContextCapsule } from "../types/capsule.js";
import type { ActivationDecision } from "./activation.js";

export interface ResolvedCapsule {
  capsule: ContextCapsule;
  decision: ActivationDecision;
}

export function resolveConflicts(active: ResolvedCapsule[]): {
  kept: ResolvedCapsule[];
  suppressed: ResolvedCapsule[];
} {
  const groups = new Map<string, ResolvedCapsule[]>();
  const ungrouped: ResolvedCapsule[] = [];
  for (const r of active) {
    const g = r.capsule.conflictGroup;
    if (g === undefined) {
      ungrouped.push(r);
    } else {
      const list = groups.get(g) ?? [];
      list.push(r);
      groups.set(g, list);
    }
  }
  const kept: ResolvedCapsule[] = [...ungrouped];
  const suppressed: ResolvedCapsule[] = [];
  for (const [, members] of groups) {
    const mustKeep = members.some(
      (r) => r.capsule.tokenBudget.overflow === "must_keep",
    );
    if (mustKeep) {
      kept.push(...members);
      continue;
    }
    members.sort(
      (a, b) =>
        b.capsule.priority - a.capsule.priority ||
        a.capsule.id.localeCompare(b.capsule.id),
    );
    const winner = members[0];
    if (winner !== undefined) kept.push(winner);
    suppressed.push(...members.slice(1));
  }
  return { kept, suppressed };
}
