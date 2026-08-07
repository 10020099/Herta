import { describe, expect, it } from "vitest";

describe("@herta/herta sanity", () => {
  it("can import @herta/core types", async () => {
    const core = await import("@herta/core");
    expect(typeof core.CodingAgentRuntime).toBe("function");
  });
});
