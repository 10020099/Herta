import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { spawnGit } from "./spawn-git.js";

const GIT_AVAILABLE = (() => {
  try {
    const r = spawnSync("git", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
})();

// Same file-level timeout as git-status/git-diff, and for the same reason:
// these spawn real git processes, and under full-suite load on Windows the
// multi-spawn cases were measured at 1.7-3.3s against the 5s default — the
// next one armed to flake, so it gets the guard before it does.
describe.skipIf(!GIT_AVAILABLE)("spawnGit", { timeout: 20_000 }, () => {
  it("happy path: git status in a fresh repo returns ok", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await spawnGit(ws.root, ["init", "-q"], new AbortController().signal);
      await spawnGit(
        ws.root,
        ["config", "user.email", "test@example.com"],
        new AbortController().signal,
      );
      await spawnGit(
        ws.root,
        ["config", "user.name", "Test"],
        new AbortController().signal,
      );
      const r = await spawnGit(
        ws.root,
        ["status", "--porcelain=v1", "--branch"],
        new AbortController().signal,
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.stdout).toContain("##");
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("not_a_repo: spawning in a non-repo tmp dir returns code not_a_repo", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const r = await spawnGit(
        ws.root,
        ["status", "--porcelain=v1"],
        new AbortController().signal,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_a_repo");
    } finally {
      await ws.cleanup();
    }
  });

  it("git_failed: invalid ref returns code git_failed with stderr", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      await spawnGit(ws.root, ["init", "-q"], new AbortController().signal);
      const r = await spawnGit(
        ws.root,
        ["diff", "--stat", "no-such-ref-xyz"],
        new AbortController().signal,
      );
      expect(r.ok).toBe(false);
      if (!r.ok && r.code === "git_failed") {
        expect(r.stderr.length).toBeGreaterThan(0);
      } else {
        throw new Error(`expected git_failed, got ${r.ok ? "ok" : r.code}`);
      }
    } finally {
      await ws.cleanup();
    }
  });
});
