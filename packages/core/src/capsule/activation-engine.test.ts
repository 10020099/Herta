import { describe, expect, it } from "vitest";
import type { ContextCapsule } from "../types/capsule.js";
import { activate } from "./activation-engine.js";
import type { Evidence } from "./types.js";

const FIXED_NOW = new Date("2026-05-05T12:00:00.000Z");

function makeCapsule(overrides: Partial<ContextCapsule>): ContextCapsule {
  return {
    id: "default",
    type: "lore",
    source: { kind: "built_in", trust: "trusted" },
    content: "some content",
    activation: { mode: "always" },
    priority: 1,
    insertionLayer: "retrieved_lore",
    tokenBudget: { maxTokens: 200, overflow: "drop" },
    deterministic: true,
    enabled: true,
    ...overrides,
  };
}

function makeEvidence(userMessage = ""): Evidence {
  return {
    userMessage,
    workspaceRoot: "/repo",
    loreExplicit: false,
  };
}

describe("activate", () => {
  it("single always-on capsule → kept, trace.activated has 1 entry, trace.suppressed empty", () => {
    const capsule = makeCapsule({
      id: "always-one",
      activation: { mode: "always" },
    });
    const { kept, trace } = activate({
      capsules: [capsule],
      evidence: makeEvidence(),
      now: () => FIXED_NOW,
    });
    expect(kept).toHaveLength(1);
    expect(trace.activated).toHaveLength(1);
    expect(trace.activated[0]?.capsuleId).toBe("always-one");
    expect(trace.suppressed).toHaveLength(0);
  });

  it("inactive capsule (any mode, no patterns match) → in trace.suppressed with appropriate reason", () => {
    const capsule = makeCapsule({
      id: "inactive-one",
      activation: { mode: "any", userMessagePatterns: ["special"] },
    });
    const { kept, trace } = activate({
      capsules: [capsule],
      evidence: makeEvidence("unrelated message"),
      now: () => FIXED_NOW,
    });
    expect(kept).toHaveLength(0);
    expect(trace.activated).toHaveLength(0);
    expect(trace.suppressed).toHaveLength(1);
    expect(trace.suppressed[0]?.capsuleId).toBe("inactive-one");
    expect(trace.suppressed[0]?.reason).toBe("no userMessagePatterns matched");
  });

  it("two capsules same conflict group, both active → one activated, one suppressed with group reason", () => {
    const capsuleA = makeCapsule({
      id: "group-low",
      priority: 1,
      conflictGroup: "grp",
      activation: { mode: "always" },
    });
    const capsuleB = makeCapsule({
      id: "group-high",
      priority: 10,
      conflictGroup: "grp",
      activation: { mode: "always" },
    });
    const { kept, trace } = activate({
      capsules: [capsuleA, capsuleB],
      evidence: makeEvidence(),
      now: () => FIXED_NOW,
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.capsule.id).toBe("group-high");
    expect(trace.activated).toHaveLength(1);
    expect(trace.suppressed).toHaveLength(1);
    expect(trace.suppressed[0]?.capsuleId).toBe("group-low");
    expect(trace.suppressed[0]?.reason).toContain("grp");
  });

  it("capsule in retrieved_lore with content > 3200 chars → suppressed with budget-exceeded reason", () => {
    // 3200 chars = 800 tokens = exactly at cap. 3204 chars = 801 tokens → over.
    const bigContent = "a".repeat(3204);
    const blockingCapsule = makeCapsule({
      id: "blocker",
      content: "a".repeat(800), // 200 tokens — takes some budget
      insertionLayer: "retrieved_lore",
      priority: 10,
      activation: { mode: "always" },
    });
    const bigCapsule = makeCapsule({
      id: "big",
      content: bigContent,
      insertionLayer: "retrieved_lore",
      priority: 5,
      activation: { mode: "always" },
      tokenBudget: { maxTokens: 2000, overflow: "drop" },
    });
    const { trace } = activate({
      capsules: [blockingCapsule, bigCapsule],
      evidence: makeEvidence(),
      now: () => FIXED_NOW,
    });
    const suppressed = trace.suppressed.find((e) => e.capsuleId === "big");
    expect(suppressed).toBeDefined();
    expect(suppressed?.reason).toBe("dropped: token budget exceeded");
    const lore = trace.budgets.find(
      (b) => b.insertionLayer === "retrieved_lore",
    );
    expect(lore?.droppedCount).toBe(1);
  });

  it("trace.ts comes from opts.now()", () => {
    const { trace } = activate({
      capsules: [],
      evidence: makeEvidence(),
      now: () => FIXED_NOW,
    });
    expect(trace.ts).toBe("2026-05-05T12:00:00.000Z");
  });

  it("disabled capsule → in trace.suppressed with reason 'disabled'", () => {
    const capsule = makeCapsule({
      id: "disabled-cap",
      enabled: false,
      activation: { mode: "always" },
    });
    const { kept, trace } = activate({
      capsules: [capsule],
      evidence: makeEvidence(),
      now: () => FIXED_NOW,
    });
    expect(kept).toHaveLength(0);
    expect(trace.suppressed).toHaveLength(1);
    expect(trace.suppressed[0]?.capsuleId).toBe("disabled-cap");
    expect(trace.suppressed[0]?.reason).toBe("disabled");
  });
});
