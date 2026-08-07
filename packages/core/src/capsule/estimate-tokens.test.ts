import { describe, expect, it } from "vitest";
import { estimateTokens } from "./estimate-tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 1 for 4-char string", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("returns 3 for 9-char string (ceil(9/4)=3)", () => {
    expect(estimateTokens("a".repeat(9))).toBe(3);
  });

  it("returns 3 for 11-char string (ceil(11/4)=3)", () => {
    expect(estimateTokens("12345678901")).toBe(3);
  });
});
