import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTmpDir } from "../testing/tmp-workspace.js";
import { findBash } from "./find-bash.js";
import { PersistentShell } from "./persistent-shell.js";
import { makeMsysPaths, shellPathsFor } from "./shell-paths.js";

// Real bash processes: comfortably over the 5 s default under suite load; the
// hook budget covers removeTmpDir's patient teardown on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BASH = findBash();
const d = describe.skipIf(BASH === null);

let ws: string;
let shell: PersistentShell;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "psh-")));
  shell = new PersistentShell({ bashPath: BASH as string, workspaceRoot: ws });
});
afterEach(async () => {
  await shell.kill();
  await removeTmpDir(ws);
});

d("PersistentShell (real bash)", () => {
  it("runs a command, merges stderr in order, reports the exit code", async () => {
    // Natural output — the command's own trailing newline is kept. `(exit 3)`
    // in a subshell: a top-level `exit` really exits the shell (bash
    // semantics; the tool reports "[shell exited]" and respawns next call).
    const r = await shell.run("echo out; echo err 1>&2; (exit 3)", {
      timeoutMs: 10_000,
    });
    expect(r.output).toBe("out\nerr\n");
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.freshShell).toBe(true);
    expect(r.cwdReset).toBe(false);
  });

  it("keeps cwd, variables and functions across calls (the trained shape's persistence)", async () => {
    writeFileSync(join(ws, "a.txt"), "A\n");
    await shell.run(
      "mkdir sub && cd sub && export FOO=bar && f() { echo fn:$1; }",
      { timeoutMs: 10_000 },
    );
    const r = await shell.run("pwd; echo $FOO; f x; ls ../a.txt", {
      timeoutMs: 10_000,
    });
    expect(r.freshShell).toBe(false);
    expect(r.output.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/\/sub$/),
      "bar",
      "fn:x",
      "../a.txt",
    ]);
    expect(r.cwd).toBe(join(ws, "sub"));
    expect(shell.cwd).toBe(join(ws, "sub"));
  });

  it("a stdin-reading command cannot eat the next command (stdin is /dev/null)", async () => {
    const r = await shell.run("cat", { timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("");
    const r2 = await shell.run("echo still-alive", { timeoutMs: 10_000 });
    expect(r2.output).toBe("still-alive\n");
    expect(r2.freshShell).toBe(false);
  });

  it("heredocs work inside the wrapper (they read the script, not stdin)", async () => {
    const r = await shell.run(
      "cat > h.txt <<'EOF'\nline1\nline2\nEOF\ncat h.txt",
      { timeoutMs: 10_000 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("line1\nline2\n");
  });

  it("a `set -e` in one call does not make the next call's first failure kill the shell", async () => {
    await shell.run("set -e; export A=1", { timeoutMs: 10_000 });
    const r = await shell.run("false; echo A=$A", { timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("A=1\n");
    expect(r.freshShell).toBe(false);
  });

  it("puts the shell back into the workspace when a command leaves it, and says so", async () => {
    const r = await shell.run("cd .. && pwd", { timeoutMs: 10_000 });
    expect(r.cwdReset).toBe(true);
    expect(r.cwd).toBe(ws);
    const r2 = await shell.run("pwd", { timeoutMs: 10_000 });
    expect(
      shellPathsFor(BASH).toNative(r2.output.trim()) ?? r2.output.trim(),
    ).toBe(ws);
  });

  it("times out a hung command, kills the tree, and the next call gets a fresh shell", async () => {
    await shell.run("export KEEP=1", { timeoutMs: 10_000 });
    const r = await shell.run("echo before; sleep 30; echo after", {
      timeoutMs: 800,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain("before");
    expect(shell.isRunning()).toBe(false);
    const r2 = await shell.run("echo KEEP=$KEEP", { timeoutMs: 10_000 });
    expect(r2.freshShell).toBe(true);
    expect(r2.output).toBe("KEEP=\n");
    expect(shell.spawns).toBe(2);
  });

  it("bounds a chatty command: keeps the tail, counts the total", async () => {
    const small = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws,
      maxOutputBytes: 2_000,
    });
    try {
      const r = await small.run(
        "for i in $(seq 1 2000); do echo line-$i-xxxxxxxxxxxxxxxxxxxx; done",
        {
          timeoutMs: 20_000,
        },
      );
      expect(r.capped).toBe(true);
      expect(r.outputBytes).toBeGreaterThan(50_000);
      expect(r.output.length).toBeLessThan(2_400);
      expect(r.output).toContain("line-2000-");
      expect(r.output.startsWith("[earlier output dropped")).toBe(true);
    } finally {
      await small.kill();
    }
  });

  it("registers as an INTERNAL background process and kill() is idempotent", async () => {
    expect(shell.internal).toBe(true);
    expect(shell.id).toBe("shell");
    await shell.run("true", { timeoutMs: 10_000 });
    expect(shell.isRunning()).toBe(true);
    await shell.kill();
    await shell.kill();
    expect(shell.isRunning()).toBe(false);
  });

  it("knows how the shell spells the workspace", async () => {
    await shell.run("true", { timeoutMs: 10_000 });
    const spelled = shell.workspaceShellPath;
    const r = await shell.run("pwd", { timeoutMs: 10_000 });
    expect(r.output.trim()).toBe(spelled);
  });
});

// win32-only: makeMsysPaths builds on node:path `resolve`, whose drive-letter
// semantics exist only there — on the Linux CI runner `resolve("E:\\repo")`
// is a RELATIVE join against cwd and the expectations are meaningless
// (scheduled CI 2026-08-18: 1 failed with `/home/runner/…/E:\repo\src`).
// The mapping itself is unreachable off-Windows: shellPathsFor returns the
// identity mapping on POSIX.
describe.skipIf(process.platform !== "win32")(
  "shell paths (MSYS mapping, pure)",
  () => {
    const p = makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp");
    it("maps drive, cygdrive, /tmp and native forms; rejects relative and MSYS-internal roots", () => {
      expect(p.toNative("/e/repo/src")).toBe("E:\\repo\\src");
      expect(p.toNative("/cygdrive/c/x")).toBe("C:\\x");
      expect(p.toNative("/tmp/lab/ws")).toBe(
        "C:\\Users\\u\\AppData\\Local\\Temp\\lab\\ws",
      );
      expect(p.toNative("E:/repo/a.ts")).toBe("E:\\repo\\a.ts");
      expect(p.toNative("src/a.ts")).toBeNull();
      expect(p.toNative("/usr/bin")).toBeNull();
      expect(p.toShell("E:\\repo\\src")).toBe("/e/repo/src");
      expect(p.toShell("C:\\Users\\u\\AppData\\Local\\Temp\\lab")).toBe(
        "/tmp/lab",
      );
    });
  },
);
