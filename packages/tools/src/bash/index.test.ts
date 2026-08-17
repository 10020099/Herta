import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  RulePermissionEngine,
  type RunCommandData,
  TodoStore,
} from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { findBash } from "./find-bash.js";

// Real bash processes: comfortably over the 5 s default when the suite runs
// alongside the runner/spawn tests.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { bashTool, registerBashRule, SHELL_BG_ID } from "./index.js";
import { PersistentShell } from "./persistent-shell.js";
import { bashJsonSchema, bashZodJsonSchema } from "./schema.js";

const BASH = findBash();
const d = describe.skipIf(BASH === null);

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});
const noopProgress = () => {};
function ctxFor(workspaceRoot: string) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    todos: new TodoStore(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}
const call = (command: string, id = "c1") => ({
  id,
  tool: "bash",
  input: { command },
});

describe("bash schema", () => {
  it("the hand-written wire schema and the zod schema agree on shape", () => {
    expect(bashJsonSchema.required).toEqual(["command"]);
    expect(Object.keys(bashJsonSchema.properties)).toEqual(["command"]);
    const zod = bashZodJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(zod.properties ?? {})).toEqual(["command"]);
    expect(zod.required).toEqual(["command"]);
  });
});

d("bash tool (real bash)", () => {
  it("runs a command: model sees plain output, harness gets RunCommandData, log persisted, shell registered internal", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "hello\n" });
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const r = await tool.run(call("cat a.txt; echo done"), ctx, noopProgress);
    expect(r.ok).toBe(true);
    expect(r.modelText).toBe("hello\ndone\n");
    const data = r.data as RunCommandData;
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe("hello\ndone\n");
    expect(data.argv).toEqual(["cat a.txt; echo done"]);
    expect(existsSync(join(ws.root, data.logPath))).toBe(true);
    expect(r.summary).toMatch(/^ran `cat a\.txt; echo done` \(exit 0/);
    // The shell is an internal background entry: reaped by stopAll, invisible to the model.
    expect(ctx.bg.getInternal(SHELL_BG_ID)).toBeInstanceOf(PersistentShell);
    expect(ctx.bg.list()).toHaveLength(0);
    expect(await ctx.bg.stopAll()).toBe(0);
    expect(
      (ctx.bg.getInternal(SHELL_BG_ID) as PersistentShell).isRunning(),
    ).toBe(false);
  });

  it("non-zero exit is appended the trained way; state persists across calls in one brief", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    await tool.run(
      call("export MARK=42; mkdir sub; cd sub", "c1"),
      ctx,
      noopProgress,
    );
    const r = await tool.run(
      call("echo $MARK; ls nope 2>&1; false", "c2"),
      ctx,
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(r.modelText).toMatch(/^42\n/);
    expect(r.modelText).toMatch(/\[exit code: 1\]$/);
    expect((r.data as RunCommandData).exitCode).toBe(1);
    await ctx.bg.stopAll();
  });

  it("test evidence: a `node --test` segment yields a testRun the report can cite", async () => {
    ws = await mkTmpWorkspace({
      "t.test.mjs": "import test from 'node:test'; test('ok', () => {});\n",
    });
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const r = await tool.run(call("node --test t.test.mjs"), ctx, noopProgress);
    expect(r.ok).toBe(true);
    const data = r.data as RunCommandData;
    expect(data.testRun?.status).toBe("passed");
    expect(data.testRun?.command).toBe("node --test t.test.mjs");
    await ctx.bg.stopAll();
  });

  it("the rule: allow-listed reads pass, writes/unknowns ask, catastrophes deny; the effective cwd follows the shell", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n", "sub/b.txt": "y\n" });
    const ctx = ctxFor(ws.root);
    const engine = new RulePermissionEngine({
      ask: { present: async () => "allow" },
    });
    registerBashRule(engine, { bashPath: BASH });
    expect((await engine.check(call("cat a.txt"), ctx)).kind).toBe("allow");
    expect((await engine.check(call("echo x > a.txt"), ctx)).kind).toBe("ask");
    // The ask carries the effective argv (approval cache scope + ADR 0030
    // rules) when the line runs ONE program — even behind the model's
    // `cd <workspace> &&` prefix — and nothing otherwise.
    const wsShell = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws.root,
    }).workspaceShellPath;
    const single = await engine.check(
      call(`cd ${wsShell} && git commit -m x`),
      ctx,
    );
    expect(single.kind).toBe("ask");
    if (single.kind === "ask") {
      expect(single.request.argv).toEqual(["git", "commit", "-m", "x"]);
    }
    const multi = await engine.check(
      call("git add -A && git commit -m x"),
      ctx,
    );
    expect(multi.kind).toBe("ask");
    if (multi.kind === "ask") {
      // No single argv (rules can't pin a chained line) …
      expect(multi.request.argv).toBeUndefined();
      // … but the task cache can still scope it by its one program.
      expect(multi.request.programs).toEqual(["git"]);
    }
    // An interpreter line still carries argv (ADR 0030 rules accept the
    // script-pinned shape); the CACHE excludes it separately.
    const interp = await engine.check(call("node scripts/x.mjs"), ctx);
    expect(interp.kind).toBe("ask");
    if (interp.kind === "ask") {
      expect(interp.request.argv).toEqual(["node", "scripts/x.mjs"]);
      expect(interp.request.code).toBe("command_ask_interpreter");
    }
    const blocked = await engine.check(call("rm -rf /"), ctx);
    expect(blocked.kind).toBe("deny");
    // After the shell has cd'd into sub/, a relative read resolves there.
    const tool = bashTool({ bashPath: BASH as string });
    await tool.run(call("cd sub", "c9"), ctx, noopProgress);
    expect((await engine.check(call("cat b.txt"), ctx)).kind).toBe("allow");
    // …and a `..` read from there is still a workspace read (allowed by
    // realpath), while escaping the workspace asks.
    expect((await engine.check(call("cat ../a.txt"), ctx)).kind).toBe("ask");
    await ctx.bg.stopAll();
  });

  it("summarize: the record header drops the model's `cd <workspace> &&` in the SHELL's own spelling (MSYS `/tmp/…` under %TEMP%), which the loop cannot derive", async () => {
    ws = await mkTmpWorkspace({});
    const tool = bashTool({ bashPath: BASH as string });
    const wsShell = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws.root,
    }).workspaceShellPath;
    const ctx = { workspaceRoot: ws.root };
    expect(
      tool.summarize?.(
        { command: `cd ${wsShell} && git add -A && git commit -m x` },
        ctx,
      ),
    ).toBe("git add -A && git commit -m x");
    // Paths inside the workspace, shell-spelled, relativize too.
    expect(
      tool.summarize?.({ command: `sed -n 1,5p ${wsShell}/a.txt` }, ctx),
    ).toBe("sed -n 1,5p ./a.txt");
    // A cd into a subdirectory is information and stays.
    expect(
      tool.summarize?.({ command: `cd ${wsShell} && cd sub && ls` }, ctx),
    ).toBe("cd sub && ls");
    // Not a command → the loop's generic form takes over.
    expect(tool.summarize?.({ nope: 1 }, ctx)).toBeUndefined();
  });

  it("refuses an empty command with a model-facing message and no shell spawn", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const r = await tool.run(
      { id: "c1", tool: "bash", input: { command: "" } },
      ctx,
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.modelText).toContain("Parameter `command` is required");
    expect(ctx.bg.getInternal(SHELL_BG_ID)).toBeUndefined();
  });
});
