import { describe, expect, it } from "vitest";
import type { ContextCapsule } from "../types/capsule.js";
import { evaluateActivation } from "./activation.js";
import type { Evidence } from "./types.js";

function makeCapsule(
  overrides: Partial<ContextCapsule> & {
    activation: ContextCapsule["activation"];
  },
): ContextCapsule {
  const { activation, enabled = true, ...rest } = overrides;
  return {
    id: "test-capsule",
    type: "lore",
    source: { kind: "built_in", trust: "trusted" },
    content: "test content",
    activation,
    priority: 1,
    insertionLayer: "retrieved_lore",
    tokenBudget: { maxTokens: 200, overflow: "drop" },
    deterministic: true,
    enabled,
    ...rest,
  };
}

function makeEvidence(userMessage: string): Evidence {
  return {
    userMessage,
    workspaceRoot: "/repo",
    loreExplicit: false,
  };
}

describe("evaluateActivation", () => {
  it("always mode returns active regardless of evidence", () => {
    const capsule = makeCapsule({ activation: { mode: "always" } });
    const result = evaluateActivation(capsule, makeEvidence("anything"));
    expect(result.active).toBe(true);
    expect(result.reason).toBe("always-on");
  });

  it("enabled=false returns inactive even when mode would activate", () => {
    const capsule = makeCapsule({
      activation: { mode: "always" },
      enabled: false,
    });
    const result = evaluateActivation(capsule, makeEvidence("anything"));
    expect(result.active).toBe(false);
    expect(result.reason).toBe("disabled");
  });

  it("any mode: message containing pattern → active", () => {
    const capsule = makeCapsule({
      activation: { mode: "any", userMessagePatterns: ["foo", "bar"] },
    });
    const result = evaluateActivation(capsule, makeEvidence("foo bar"));
    expect(result.active).toBe(true);
  });

  it("any mode: message not containing any pattern → inactive", () => {
    const capsule = makeCapsule({
      activation: { mode: "any", userMessagePatterns: ["foo", "bar"] },
    });
    const result = evaluateActivation(capsule, makeEvidence("zzz"));
    expect(result.active).toBe(false);
    expect(result.reason).toBe("no userMessagePatterns matched");
  });

  it("all mode: message containing all patterns → active", () => {
    const capsule = makeCapsule({
      activation: { mode: "all", userMessagePatterns: ["foo", "bar"] },
    });
    const result = evaluateActivation(capsule, makeEvidence("foo bar baz"));
    expect(result.active).toBe(true);
    expect(result.reason).toBe("all userMessagePatterns matched");
  });

  it("all mode: message missing one pattern → inactive", () => {
    const capsule = makeCapsule({
      activation: { mode: "all", userMessagePatterns: ["foo", "bar"] },
    });
    const result = evaluateActivation(capsule, makeEvidence("foo only"));
    expect(result.active).toBe(false);
  });

  it("all mode with empty patterns → inactive (sensible default)", () => {
    const capsule = makeCapsule({
      activation: { mode: "all", userMessagePatterns: [] },
    });
    const result = evaluateActivation(capsule, makeEvidence("foo bar"));
    expect(result.active).toBe(false);
    expect(result.reason).toBe("all mode with no patterns");
  });

  it("not mode inverts: pattern matched → inactive", () => {
    const capsule = makeCapsule({
      activation: { mode: "not", userMessagePatterns: ["foo"] },
    });
    const result = evaluateActivation(capsule, makeEvidence("foo"));
    expect(result.active).toBe(false);
    expect(result.reason).toContain("not:");
  });

  it("not mode inverts: pattern not matched → active", () => {
    const capsule = makeCapsule({
      activation: { mode: "not", userMessagePatterns: ["foo"] },
    });
    const result = evaluateActivation(capsule, makeEvidence("bar"));
    expect(result.active).toBe(true);
    expect(result.reason).toContain("not:");
  });

  it("scored mode → inactive with reason about MVP", () => {
    const capsule = makeCapsule({ activation: { mode: "scored" } });
    const result = evaluateActivation(capsule, makeEvidence("anything"));
    expect(result.active).toBe(false);
    expect(result.reason).toBe("scored mode not supported in MVP");
  });
});
