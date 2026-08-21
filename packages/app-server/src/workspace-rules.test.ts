import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectRules, withProjectRules } from "./workspace-rules.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "herta-rules-"));
  workspaces.push(workspace);
  mkdirSync(join(workspace, ".herta"));
  return workspace;
}

describe("loadProjectRules", () => {
  it("loads only rules.md and rules followed by a numeric suffix in numeric order", () => {
    const workspace = makeWorkspace();
    const rulesDir = join(workspace, ".herta");
    writeFileSync(join(rulesDir, "rules10.md"), "ten", "utf-8");
    writeFileSync(join(rulesDir, "rules2.md"), "two", "utf-8");
    writeFileSync(join(rulesDir, "rules.md"), "base", "utf-8");
    writeFileSync(join(rulesDir, "rules-extra.md"), "ignore me", "utf-8");
    writeFileSync(join(rulesDir, "notes.md"), "ignore me too", "utf-8");

    const snapshot = loadProjectRules(workspace);

    expect(snapshot.files).toEqual(["rules.md", "rules2.md", "rules10.md"]);
    expect(snapshot.text).toContain("# 项目规则");
    expect(snapshot.text).toContain("## rules.md\n\nbase");
    expect(snapshot.text).toContain("## rules2.md\n\ntwo");
    expect(snapshot.text).toContain("## rules10.md\n\nten");
    expect(snapshot.text).not.toContain("ignore me");
    expect(snapshot.truncated).toBe(false);
  });

  it("returns an empty prompt-ready snapshot when the workspace has no rules directory", () => {
    const workspace = mkdtempSync(join(tmpdir(), "herta-rules-empty-"));
    workspaces.push(workspace);
    expect(loadProjectRules(workspace)).toEqual({
      text: "",
      files: [],
      truncated: false,
    });
  });
});

describe("withProjectRules", () => {
  it("appends rules after the compiled environment without adding noise when absent", () => {
    expect(withProjectRules("base environment", "project rules")).toBe(
      "base environment\n\nproject rules",
    );
    expect(withProjectRules("base environment", "")).toBe("base environment");
  });
});
