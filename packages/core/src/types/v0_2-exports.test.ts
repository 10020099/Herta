import { describe, expect, it } from "vitest";
import * as core from "../index.js";

describe("@herta/core v0.2 type exports", () => {
  it("exports SYSTEM_BLOCK_LABELS constant", () => {
    expect(core.SYSTEM_BLOCK_LABELS).toEqual(["系统", "差分协处理器"]);
  });

  it("exports isSystemBlockLabel runtime guard", () => {
    expect(core.isSystemBlockLabel("系统")).toBe(true);
    expect(core.isSystemBlockLabel("板砖")).toBe(false);
  });

  it("exports InMemoryEvidenceStore class", () => {
    const store = new core.InMemoryEvidenceStore();
    const handle = store.put({ kind: "diff", payload: "x" });
    expect(handle.uri.startsWith("evidence://")).toBe(true);
  });
});
