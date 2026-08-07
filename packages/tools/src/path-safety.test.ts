import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSafePath } from "./path-safety.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";

async function canCreateFileSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "herta-symlink-probe-"));
  try {
    await writeFile(join(probe, "target.txt"), "x");
    await symlink(join(probe, "target.txt"), join(probe, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

describe("resolveSafePath", () => {
  beforeEach(async () => {
    ws = await mkTmpWorkspace({
      "src/foo.ts": "x",
      "src/.gitkeep": "",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".env": "SECRET=1\n",
      ".env.example": "SECRET=\n",
      ".env.local": "SECRET=local\n",
      "keys/private.pem": "-----BEGIN RSA-----",
      "keys/access.key": "abc",
      "keys/cert.p12": "bin",
      "deepseek-api-key.txt": "sk-test",
      id_rsa: "key",
      "id_rsa.pub": "key.pub",
      id_ecdsa: "key",
      ".netrc": "machine x",
      ".npmrc": "//r/:_authToken=sk",
      ".pgpass": "host:5432:db:u:p",
      ".git-credentials": "https://u:p@github.com",
      "config/credentials": "aws creds",
      "credentials.ts": "export const x = 1;",
      ".ssh/config": "Host *",
      ".aws/credentials": "[default]",
      ".herta/keys/deepseek": "sk",
      ".herta/memory/project.jsonl": "{}",
      ".herta/logs/run.log": "log",
      ".herta/capsules/project.json": "{}",
      "ok.md": "ok",
    });
  });

  it("allows a path inside the workspace", async () => {
    const r = await resolveSafePath(ws.root, "src/foo.ts");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.relative).toBe("src/foo.ts");
      expect(r.resolved.startsWith(ws.root)).toBe(true);
    }
  });

  it("allows the workspace root itself", async () => {
    const r = await resolveSafePath(ws.root, ".");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("");
  });

  it("denies a path outside the workspace via parent traversal", async () => {
    const r = await resolveSafePath(ws.root, "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_outside_workspace");
  });

  it("denies a symlink that escapes the workspace", async () => {
    const symlinkable = await canCreateFileSymlinks();
    if (!symlinkable) {
      // Windows without admin / Developer Mode cannot create file symlinks.
      // The realpath-based escape check is also exercised on Windows by the
      // parent-traversal test above; skip without failing.
      return;
    }
    const outside = `${ws.root}-sibling`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "leak");
    await symlink(join(outside, "secret.txt"), join(ws.root, "linked.txt"));
    const r = await resolveSafePath(ws.root, "linked.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_outside_workspace");
    await rm(outside, { recursive: true, force: true });
  });

  it("denies .git/ paths", async () => {
    const r = await resolveSafePath(ws.root, ".git/HEAD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies .env", async () => {
    const r = await resolveSafePath(ws.root, ".env");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies .env.local but allows .env.example", async () => {
    const denied = await resolveSafePath(ws.root, ".env.local");
    const allowed = await resolveSafePath(ws.root, ".env.example");
    expect(denied.ok).toBe(false);
    expect(allowed.ok).toBe(true);
  });

  it("denies *.pem", async () => {
    const r = await resolveSafePath(ws.root, "keys/private.pem");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies *.key", async () => {
    const r = await resolveSafePath(ws.root, "keys/access.key");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies *-api-key.txt", async () => {
    const r = await resolveSafePath(ws.root, "deepseek-api-key.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies id_rsa and id_rsa.pub", async () => {
    const a = await resolveSafePath(ws.root, "id_rsa");
    const b = await resolveSafePath(ws.root, "id_rsa.pub");
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it("denies .herta/keys/<anything>", async () => {
    const r = await resolveSafePath(ws.root, ".herta/keys/deepseek");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies the whole .herta tree (memory/logs/capsules), not just keys (audit T3.4)", async () => {
    for (const p of [
      ".herta",
      ".herta/memory/project.jsonl",
      ".herta/logs/run.log",
      ".herta/capsules/project.json",
    ]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  describe("harness-evidence read carve-out (ADR 0025 slice 2)", () => {
    const opts = { allowHarnessReadPaths: true };

    it("allows files beneath .herta/logs/ and .herta/tool-results/ with the flag", async () => {
      const a = await resolveSafePath(ws.root, ".herta/logs/run.log", opts);
      expect(a.ok).toBe(true);
      const b = await resolveSafePath(
        ws.root,
        ".herta/tool-results/task-1/call_01.json",
        opts,
      );
      expect(b.ok).toBe(true);
    });

    it("without the flag the same paths stay denied", async () => {
      const r = await resolveSafePath(ws.root, ".herta/logs/run.log");
      expect(r.ok).toBe(false);
    });

    it("the carve-out covers ONLY the two evidence subtrees, never the rest of .herta", async () => {
      for (const p of [
        ".herta",
        ".herta/logs", // the directory itself, not a file beneath it
        ".herta/keys/deepseek",
        ".herta/memory/project.jsonl",
        ".herta/capsules/project.json",
        ".herta/logs-evil/x.log", // prefix must match a whole segment
      ]) {
        const r = await resolveSafePath(ws.root, p, opts);
        expect(r.ok, `expected ${p} denied`).toBe(false);
      }
    });

    it("credential basenames stay denied even inside the carve-out", async () => {
      const r = await resolveSafePath(ws.root, ".herta/logs/id_rsa", opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    });

    it("a symlink inside logs pointing at .herta/keys is judged on its target", async () => {
      const linkPath = join(ws.root, ".herta", "logs", "sneaky.log");
      try {
        await symlink(join(ws.root, ".herta", "keys", "deepseek"), linkPath);
      } catch {
        return; // symlink creation unavailable (Windows non-admin) — skip
      }
      const r = await resolveSafePath(ws.root, ".herta/logs/sneaky.log", opts);
      expect(r.ok).toBe(false);
    });
  });

  it("denies the unified credential basenames (audit T3.4)", async () => {
    for (const p of [
      ".netrc",
      ".npmrc",
      ".pgpass",
      ".git-credentials",
      "config/credentials",
      "id_ecdsa",
      "keys/cert.p12",
    ]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  it("denies sensitive .ssh/.aws directory segments (audit T3.4)", async () => {
    for (const p of [".ssh/config", ".aws/credentials"]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  it("still allows ordinary files whose names merely contain credential words", async () => {
    const r = await resolveSafePath(ws.root, "credentials.ts");
    expect(r.ok).toBe(true);
  });

  it("falls back to lexical resolve when target does not exist (ENOENT)", async () => {
    const r = await resolveSafePath(ws.root, "src/missing.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("src/missing.ts");
  });

  it("allows a deeply nonexistent path under an existing ancestor", async () => {
    // Exercises realpathViaExistingAncestor walking up more than one
    // level ("new/" doesn't exist either) and re-joining the suffix.
    const r = await resolveSafePath(ws.root, "src/new/deep/file.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("src/new/deep/file.ts");
  });

  it("denies a NONEXISTENT target under a directory link that escapes the workspace", async () => {
    // The write_new_file hole: the target never exists, so plain
    // realpath() throws ENOENT — the old fallback kept the UNRESOLVED
    // candidate, the prefix check passed, and the write landed outside
    // the repo through the in-workspace directory link. The ancestor
    // walk must canonicalize the link and fail the prefix check.
    const outside = `${ws.root}-sneak`;
    await mkdir(outside, { recursive: true });
    try {
      try {
        // "junction" works without admin on Windows; the type argument
        // is ignored on POSIX (plain directory symlink).
        await symlink(outside, join(ws.root, "escape"), "junction");
      } catch {
        return; // environment cannot create directory links; skip
      }
      const r = await resolveSafePath(ws.root, "escape/new-file.ts");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_outside_workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("normalizes the relative path to forward slashes", async () => {
    const r = await resolveSafePath(ws.root, "src/foo.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative.includes("\\")).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "denies Win32 name-equivalent credential/tree targets (trailing dot/space, ::$DATA) — write bypass (audit T3.4 review)",
    async () => {
      // Win32 CreateFile trims trailing dots/spaces and resolves ::$DATA, so
      // these NONEXISTENT write targets land on the denied name — the denylist
      // must compare against the canonical form.
      for (const p of [".env ", "id_rsa.", ".env::$DATA", ".herta \\x.json"]) {
        const r = await resolveSafePath(ws.root, p);
        expect(r.ok, `expected ${JSON.stringify(p)} denied`).toBe(false);
        if (!r.ok) expect(r.code).toBe("path_denied");
      }
    },
  );
});
