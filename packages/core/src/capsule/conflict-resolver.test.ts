import { describe, expect, it } from "vitest";
import type { ContextCapsule } from "../types/capsule.js";
import type { ResolvedCapsule } from "./conflict-resolver.js";
import { resolveConflicts } from "./conflict-resolver.js";

function makeCapsule(
  id: string,
  priority: number,
  conflictGroup?: string,
  overflow: ContextCapsule["tokenBudget"]["overflow"] = "drop",
): ContextCapsule {
  return {
    id,
    type: "lore",
    source: { kind: "built_in", trust: "trusted" },
    content: "content",
    activation: { mode: "always" },
    priority,
    insertionLayer: "retrieved_lore",
    tokenBudget: { maxTokens: 200, overflow },
    deterministic: true,
    enabled: true,
    conflictGroup,
  };
}

function makeResolved(
  id: string,
  priority: number,
  conflictGroup?: string,
  overflow: ContextCapsule["tokenBudget"]["overflow"] = "drop",
): ResolvedCapsule {
  return {
    capsule: makeCapsule(id, priority, conflictGroup, overflow),
    decision: { active: true, reason: "always-on" },
  };
}

describe("resolveConflicts", () => {
  it("no conflict groups: all kept, none suppressed", () => {
    const input = [
      makeResolved("A", 5),
      makeResolved("B", 10),
      makeResolved("C", 1),
    ];
    const { kept, suppressed } = resolveConflicts(input);
    expect(kept).toHaveLength(3);
    expect(suppressed).toHaveLength(0);
  });

  it("two capsules in same group, different priority: higher kept, lower suppressed", () => {
    const input = [
      makeResolved("low", 1, "groupX"),
      makeResolved("high", 10, "groupX"),
    ];
    const { kept, suppressed } = resolveConflicts(input);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.capsule.id).toBe("high");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.capsule.id).toBe("low");
  });

  it("must_keep member in group: all group members kept", () => {
    const input = [
      makeResolved("A", 5, "groupX", "must_keep"),
      makeResolved("B", 10, "groupX"),
    ];
    const { kept, suppressed } = resolveConflicts(input);
    expect(kept).toHaveLength(2);
    expect(suppressed).toHaveLength(0);
  });

  it("three capsules: A(group X, pri 5), B(group X, pri 10), C(ungrouped) → kept=[B, C], suppressed=[A]", () => {
    const input = [
      makeResolved("A", 5, "groupX"),
      makeResolved("B", 10, "groupX"),
      makeResolved("C", 3),
    ];
    const { kept, suppressed } = resolveConflicts(input);
    const keptIds = kept.map((r) => r.capsule.id).sort();
    const suppressedIds = suppressed.map((r) => r.capsule.id);
    expect(keptIds).toEqual(["B", "C"].sort());
    expect(suppressedIds).toEqual(["A"]);
  });

  it("tied priority within a group: lexicographically smaller id wins", () => {
    const input = [
      makeResolved("zeta", 5, "groupX"),
      makeResolved("alpha", 5, "groupX"),
      makeResolved("mu", 5, "groupX"),
    ];
    const { kept, suppressed } = resolveConflicts(input);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.capsule.id).toBe("alpha");
    expect(suppressed.map((r) => r.capsule.id).sort()).toEqual(["mu", "zeta"]);
  });

  it("two separate groups each picks its own winner", () => {
    const input = [
      makeResolved("X1", 5, "groupX"),
      makeResolved("X2", 10, "groupX"),
      makeResolved("Y1", 3, "groupY"),
      makeResolved("Y2", 7, "groupY"),
    ];
    const { kept, suppressed } = resolveConflicts(input);
    const keptIds = kept.map((r) => r.capsule.id).sort();
    const suppressedIds = suppressed.map((r) => r.capsule.id).sort();
    expect(keptIds).toEqual(["X2", "Y2"].sort());
    expect(suppressedIds).toEqual(["X1", "Y1"].sort());
  });
});
