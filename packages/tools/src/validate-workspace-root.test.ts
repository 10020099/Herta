import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSafePath } from "./path-safety.js";
import {
  canonicalWorkspaceRoot,
  validateWorkspaceRoot,
} from "./validate-workspace-root.js";

describe("validateWorkspaceRoot", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ws-val-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts an existing directory outside protected roots", () => {
    const r = validateWorkspaceRoot(tmp, { home: join(tmp, "home") });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(tmp);
  });
  it("rejects a non-existent path", () => {
    const r = validateWorkspaceRoot(join(tmp, "nope"), { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_not_found");
  });
  it("rejects a drive/filesystem root", () => {
    const root = parse(tmp).root;
    const r = validateWorkspaceRoot(root, { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects the home root itself", () => {
    const r = validateWorkspaceRoot(tmp, { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects anything inside ~/.herta", () => {
    const herta = join(tmp, ".herta", "workspaces", "x");
    const r = validateWorkspaceRoot(herta, { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects an OS system dir even when it doesn't exist (e.g. /etc)", () => {
    const r = validateWorkspaceRoot("/etc", { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects a System32 segment on any drive", () => {
    const r = validateWorkspaceRoot(join("D:\\", "x", "System32"), {
      home: tmp,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
});

describe("a symlinked root is canonicalized (audit S8)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "ws-link-")));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // Creating a directory symlink needs elevation or Developer Mode on Windows.
  const canSymlink = (): boolean => {
    const probe = join(tmp, `.probe-${Math.random().toString(36).slice(2)}`);
    try {
      mkdirSync(join(tmp, "probe-target"), { recursive: true });
      symlinkSync(join(tmp, "probe-target"), probe, "junction");
      rmSync(probe, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };

  it("resolves the root so paths inside it compare equal", () => {
    if (!canSymlink()) return;
    const real = join(tmp, "real-project");
    const link = join(tmp, "linked-project");
    mkdirSync(real);
    symlinkSync(real, link, "junction");

    const r = validateWorkspaceRoot(link, { home: join(tmp, "home") });
    expect(r.ok).toBe(true);
    // The whole point: resolveSafePath realpaths every candidate file, so a
    // root left as the symlink means `<link>/a.ts` canonicalizes to
    // `<real>/a.ts`, fails the prefix check, and EVERY file operation is
    // denied as outside the workspace.
    if (r.ok) expect(r.resolved).toBe(realpathSync(link));
    if (r.ok) expect(r.resolved).toBe(real);
  });

  it("the symptom: file operations under a symlinked root now resolve", async () => {
    if (!canSymlink()) return;
    const real = join(tmp, "real-project");
    const link = join(tmp, "linked-project");
    mkdirSync(real);
    writeFileSync(join(real, "a.ts"), "x", "utf8");
    symlinkSync(real, link, "junction");

    // What the raw symlinked root does — this is the bug, verbatim: every
    // candidate is canonicalized, so nothing can ever be "inside" a root that
    // is not. 100% of file operations denied.
    const viaLink = await resolveSafePath(link, "a.ts");
    expect(viaLink.ok).toBe(false);
    if (!viaLink.ok) expect(viaLink.code).toBe("path_outside_workspace");

    // What validateWorkspaceRoot now hands the runtime instead.
    const check = validateWorkspaceRoot(link, { home: join(tmp, "home") });
    expect(check.ok).toBe(true);
    if (check.ok) {
      const viaCanonical = await resolveSafePath(check.resolved, "a.ts");
      expect(viaCanonical.ok).toBe(true);
    }
  });

  it("still refuses a symlink that points into a system directory", () => {
    if (!canSymlink() || process.platform === "win32") return;
    const link = join(tmp, "sneaky");
    symlinkSync("/etc", link);
    const r = validateWorkspaceRoot(link, { home: join(tmp, "home") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
});

describe("canonicalWorkspaceRoot", () => {
  it("falls back to the lexical resolve for a path that does not exist", () => {
    // The caller is about to reject it; a throw here would surface as an
    // opaque EIO instead of "no such directory".
    const missing = join(tmpdir(), "herta-does-not-exist-9f3a2b");
    expect(canonicalWorkspaceRoot(missing)).toBe(resolve(missing));
  });

  it("is idempotent", () => {
    const once = canonicalWorkspaceRoot(tmpdir());
    expect(canonicalWorkspaceRoot(once)).toBe(once);
  });
});
