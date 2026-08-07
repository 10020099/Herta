import { describe, expect, it } from "vitest";
import type { ContextCapsule } from "../types/capsule.js";
import { allocateBudget } from "./budget-allocator.js";
import type { ResolvedCapsule } from "./conflict-resolver.js";

function makeCapsule(
  id: string,
  content: string,
  insertionLayer: ContextCapsule["insertionLayer"],
  priority: number,
  overflow: ContextCapsule["tokenBudget"]["overflow"] = "drop",
): ContextCapsule {
  return {
    id,
    type: "lore",
    source: { kind: "built_in", trust: "trusted" },
    content,
    activation: { mode: "always" },
    priority,
    insertionLayer,
    tokenBudget: { maxTokens: 2000, overflow },
    deterministic: true,
    enabled: true,
  };
}

function makeResolved(
  id: string,
  content: string,
  insertionLayer: ContextCapsule["insertionLayer"],
  priority: number,
  overflow: ContextCapsule["tokenBudget"]["overflow"] = "drop",
): ResolvedCapsule {
  return {
    capsule: makeCapsule(id, content, insertionLayer, priority, overflow),
    decision: { active: true, reason: "always-on" },
  };
}

describe("allocateBudget", () => {
  it("single capsule in retrieved_lore, small content → kept, dropped=0, budget correct", () => {
    const content = "a".repeat(100); // 25 tokens
    const input = [makeResolved("A", content, "retrieved_lore", 5)];
    const { kept, dropped, budgets } = allocateBudget(input);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    const b = budgets.find((b) => b.insertionLayer === "retrieved_lore");
    expect(b).toMatchObject({
      tokensUsed: 25,
      tokensCap: 800,
      droppedCount: 0,
    });
  });

  it("two capsules in retrieved_lore, total fits under 800 → both kept", () => {
    const content = "a".repeat(400); // 100 tokens each
    const input = [
      makeResolved("A", content, "retrieved_lore", 10),
      makeResolved("B", content, "retrieved_lore", 5),
    ];
    const { kept, dropped } = allocateBudget(input);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });

  it("three capsules in retrieved_lore where total > 800: highest priority kept, lowest dropped", () => {
    // Each capsule: 1200 chars = 300 tokens. Three = 900 tokens > 800 cap.
    const content = "a".repeat(1200); // 300 tokens each
    const input = [
      makeResolved("high", content, "retrieved_lore", 10),
      makeResolved("mid", content, "retrieved_lore", 5),
      makeResolved("low", content, "retrieved_lore", 1),
    ];
    const { kept, dropped, budgets } = allocateBudget(input);
    // high (300 tokens) fits; mid (300 + 300 = 600) fits; low (600 + 300 = 900 > 800) dropped
    expect(kept.map((r) => r.capsule.id)).toContain("high");
    expect(kept.map((r) => r.capsule.id)).toContain("mid");
    expect(dropped.map((r) => r.capsule.id)).toContain("low");
    const b = budgets.find((b) => b.insertionLayer === "retrieved_lore");
    expect(b).toMatchObject({ droppedCount: 1 });
  });

  it("tied priority within retrieved_lore: lexicographically smaller id admitted first", () => {
    // Two capsules at priority 5, only one fits under the cap.
    // Each: 3200 chars = 800 tokens — exactly fills the cap, second is dropped.
    const content = "a".repeat(3200);
    const input = [
      makeResolved("zeta", content, "retrieved_lore", 5),
      makeResolved("alpha", content, "retrieved_lore", 5),
    ];
    const { kept, dropped } = allocateBudget(input);
    expect(kept.map((r) => r.capsule.id)).toEqual(["alpha"]);
    expect(dropped.map((r) => r.capsule.id)).toEqual(["zeta"]);
  });

  it("capsule in non-lore layer with huge content → kept (no cap), tokensCap=null", () => {
    const content = "a".repeat(10000); // 2500 tokens — well over lore cap if it applied
    const input = [makeResolved("A", content, "repo_context", 5)];
    const { kept, dropped, budgets } = allocateBudget(input);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    const b = budgets.find((b) => b.insertionLayer === "repo_context");
    expect(b).toMatchObject({ tokensCap: null, droppedCount: 0 });
  });

  it("must_keep capsule in retrieved_lore past cap → kept, tokens counted, droppedCount excludes it", () => {
    // Fill most of the budget first with a normal capsule
    const normalContent = "a".repeat(3000); // 750 tokens
    const mustKeepContent = "b".repeat(400); // 100 tokens — 750 + 100 = 850 > 800 cap
    const input = [
      makeResolved("normal", normalContent, "retrieved_lore", 10, "drop"),
      makeResolved("must", mustKeepContent, "retrieved_lore", 5, "must_keep"),
    ];
    const { kept, dropped, budgets } = allocateBudget(input);
    const keptIds = kept.map((r) => r.capsule.id);
    expect(keptIds).toContain("normal");
    expect(keptIds).toContain("must");
    expect(dropped).toHaveLength(0);
    const b = budgets.find((b) => b.insertionLayer === "retrieved_lore");
    expect(b).toMatchObject({ droppedCount: 0, tokensUsed: 750 + 100 });
  });
});
