import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "./event-bus.js";
import {
  permissionCacheScope,
  SessionApprovalCache,
  wireTaskScopedApprovalCache,
} from "./session-approval-cache.js";
import type { AgentEvent, PermissionRequest } from "./types/events.js";

describe("SessionApprovalCache", () => {
  it("starts empty", () => {
    const c = new SessionApprovalCache();
    expect(c.size()).toBe(0);
    expect(c.list()).toEqual([]);
    expect(c.has("edit_file", "workspace_write", "a.ts")).toBe(false);
  });

  it("isCacheable: only edit_file/write_new_file/run_command at workspace_write WITH a scope", () => {
    const c = new SessionApprovalCache();
    expect(c.isCacheable("edit_file", "workspace_write", "a.ts")).toBe(true);
    expect(c.isCacheable("write_new_file", "workspace_write", "b.ts")).toBe(
      true,
    );
    expect(c.isCacheable("run_command", "workspace_write", "node")).toBe(true);
    // Cacheable tool but NO scope — fail-closed, not cacheable (audit T3.4).
    expect(c.isCacheable("edit_file", "workspace_write")).toBe(false);
    expect(c.isCacheable("write_new_file", "workspace_write")).toBe(false);
    expect(c.isCacheable("run_command", "workspace_write")).toBe(false);
    // Cacheable tools at non-write risks — not cacheable.
    expect(c.isCacheable("edit_file", "workspace_destructive", "a.ts")).toBe(
      false,
    );
    expect(c.isCacheable("edit_file", "workspace_read", "a.ts")).toBe(false);
    expect(c.isCacheable("edit_file", "network", "a.ts")).toBe(false);
  });

  it("add records cacheable scoped tuples", () => {
    const c = new SessionApprovalCache();
    c.add("edit_file", "workspace_write", "task");
    expect(c.size()).toBe(1);
    expect(c.has("edit_file", "workspace_write", "task")).toBe(true);
  });

  it("unifies edit_file and write_new_file under one file_write key (ADR 0026)", () => {
    const c = new SessionApprovalCache();
    // Approving "writes for this task" covers creating a file AND the
    // follow-up edits — the two tools no longer re-prompt separately.
    c.add("edit_file", "workspace_write", "task");
    expect(c.has("write_new_file", "workspace_write", "task")).toBe(true);
    expect(c.has("edit_file", "workspace_write", "task")).toBe(true);
    // A different scope still misses (run_command binaries keep theirs).
    expect(c.has("edit_file", "workspace_write", "other")).toBe(false);
  });

  it("add no-ops on non-cacheable tuples (defense-in-depth)", () => {
    const c = new SessionApprovalCache();
    c.add("run_command", "workspace_write"); // no binary scope
    c.add("edit_file", "workspace_destructive", "a.ts");
    c.add("edit_file", "network", "a.ts");
    c.add("edit_file", "workspace_write"); // no path scope
    expect(c.size()).toBe(0);
  });

  it("add is idempotent", () => {
    const c = new SessionApprovalCache();
    c.add("edit_file", "workspace_write", "a.ts");
    c.add("edit_file", "workspace_write", "a.ts");
    expect(c.size()).toBe(1);
  });

  it("clear empties the cache", () => {
    const c = new SessionApprovalCache();
    c.add("edit_file", "workspace_write", "a.ts");
    c.add("write_new_file", "workspace_write", "b.ts");
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.list()).toEqual([]);
  });

  it("list returns a sorted snapshot with the normalized tool + scope in the key", () => {
    const c = new SessionApprovalCache();
    c.add("write_new_file", "workspace_write", "task");
    c.add("run_command", "workspace_write", "git");
    const snapshot = c.list();
    expect(snapshot).toEqual([
      "file_write:task:workspace_write",
      "run_command:git:workspace_write",
    ]);
    // Mutate the cache afterwards — snapshot stays unchanged.
    c.clear();
    expect(snapshot).toEqual([
      "file_write:task:workspace_write",
      "run_command:git:workspace_write",
    ]);
  });

  describe("run_command per-binary caching", () => {
    it("isCacheable(run_command, workspace_write, <binary>) is true", () => {
      const c = new SessionApprovalCache();
      expect(c.isCacheable("run_command", "workspace_write", "python3")).toBe(
        true,
      );
      expect(c.isCacheable("run_command", "workspace_write", "node")).toBe(
        true,
      );
    });

    it("isCacheable(run_command) without binary is false (granularity required)", () => {
      const c = new SessionApprovalCache();
      expect(c.isCacheable("run_command", "workspace_write")).toBe(false);
    });

    it("isCacheable(run_command, <non-write risk>) is false even with binary", () => {
      const c = new SessionApprovalCache();
      expect(c.isCacheable("run_command", "workspace_destructive", "rm")).toBe(
        false,
      );
      expect(c.isCacheable("run_command", "network", "curl")).toBe(false);
      expect(c.isCacheable("run_command", "workspace_read", "cat")).toBe(false);
    });

    it("has(run_command, ..., binary) only matches the same binary", () => {
      const c = new SessionApprovalCache();
      c.add("run_command", "workspace_write", "python3");
      expect(c.has("run_command", "workspace_write", "python3")).toBe(true);
      expect(c.has("run_command", "workspace_write", "node")).toBe(false);
      expect(c.has("run_command", "workspace_write")).toBe(false);
    });

    it("add(run_command, workspace_destructive, binary) is no-op", () => {
      const c = new SessionApprovalCache();
      c.add("run_command", "workspace_destructive", "rm");
      expect(c.size()).toBe(0);
    });

    it("list includes the scope in every key", () => {
      const c = new SessionApprovalCache();
      c.add("edit_file", "workspace_write", "task");
      c.add("run_command", "workspace_write", "python3");
      c.add("run_command", "workspace_write", "node");
      expect(c.list()).toEqual([
        "file_write:task:workspace_write",
        "run_command:node:workspace_write",
        "run_command:python3:workspace_write",
      ]);
    });
  });
});

describe("permissionCacheScope — command wrappers (audit S5)", () => {
  const scopeFor = (argv: readonly string[]) =>
    permissionCacheScope({
      id: "r",
      call: { id: "c", tool: "run_command", input: { argv } },
      reason: "x",
      risk: "workspace_write",
    });

  it("refuses to cache WRAPPERS, which do not identify what runs", () => {
    // These were in NEVER_RULABLE but missing from the cache's own set, so
    // approving `timeout 600 npm run build` silently pre-approved
    // `timeout 5 node -e '<payload>'` for the rest of the task — no overlay.
    for (const w of [
      "timeout",
      "time",
      "sudo",
      "doas",
      "pkexec",
      "nice",
      "nohup",
      "xargs",
      "stdbuf",
      "env",
    ]) {
      expect(scopeFor([w, "600", "npm", "run", "build"])).toBeUndefined();
    }
  });

  it("still refuses the interpreters it always refused", () => {
    for (const i of [
      "python",
      "python3",
      "node",
      "bash",
      "sh",
      "npx",
      "make",
    ]) {
      expect(scopeFor([i, "build.py"])).toBeUndefined();
    }
  });

  it("normalizes path and .exe before deciding", () => {
    expect(scopeFor(["/usr/bin/timeout", "5", "x"])).toBeUndefined();
    expect(scopeFor(["C:\\tools\\python.exe", "x.py"])).toBeUndefined();
  });

  it("still caches a real binary that DOES identify what runs", () => {
    expect(scopeFor(["rustfmt", "src/lib.rs"])).toBe("rustfmt");
    expect(scopeFor(["gofmt", "-w", "main.go"])).toBe("gofmt");
  });
});

describe("wireTaskScopedApprovalCache (ADR 0026)", () => {
  const finished = (layer: "actor" | "backend"): AgentEvent =>
    ({
      type: "turn.finished",
      layer,
      summary: {
        durationMs: 1,
        toolCallCount: 0,
        messageCount: 0,
        endedAt: "t",
      },
    }) as AgentEvent;

  it("clears the cache when the BACKEND brief ends (finished or failed)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const cache = new SessionApprovalCache();
    wireTaskScopedApprovalCache(bus, cache);
    cache.add("edit_file", "workspace_write", "task");
    expect(cache.size()).toBe(1);
    bus.publish(finished("backend"));
    expect(cache.size()).toBe(0);

    cache.add("run_command", "workspace_write", "git");
    bus.publish({
      type: "turn.failed",
      layer: "backend",
      error: { kind: "provider_error", message: "boom" },
    } as unknown as AgentEvent);
    expect(cache.size()).toBe(0);
  });

  it("ignores ACTOR-layer turn ends — only the brief bounds the grant", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const cache = new SessionApprovalCache();
    wireTaskScopedApprovalCache(bus, cache);
    cache.add("edit_file", "workspace_write", "task");
    bus.publish(finished("actor"));
    expect(cache.size()).toBe(1);
  });

  it("returns an unsubscribe that detaches the wire", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const cache = new SessionApprovalCache();
    const off = wireTaskScopedApprovalCache(bus, cache);
    off();
    cache.add("edit_file", "workspace_write", "task");
    bus.publish(finished("backend"));
    expect(cache.size()).toBe(1);
  });
});

describe("permissionCacheScope", () => {
  const req = (
    tool: string,
    over: Partial<PermissionRequest> = {},
  ): PermissionRequest => ({
    id: "r1",
    call: { id: "c1", tool, input: {} },
    reason: "x",
    risk: "workspace_write",
    ...over,
  });

  it("run_command → argv[0]", () => {
    expect(
      permissionCacheScope(
        req("run_command", {
          call: {
            id: "c",
            tool: "run_command",
            input: { argv: ["npm", "test"] },
          },
        }),
      ),
    ).toBe("npm");
  });

  it("edit_file / write_new_file → the constant task scope (ADR 0026)", () => {
    // Still gated on the rule-resolved path being PRESENT — the request must
    // carry a canonical target for the ask to be cacheable at all.
    expect(
      permissionCacheScope(req("edit_file", { files: ["src/a.ts"] })),
    ).toBe("task");
    expect(
      permissionCacheScope(req("write_new_file", { files: ["src/b.ts"] })),
    ).toBe("task");
  });

  it("returns undefined (fail-closed) when the scope is missing", () => {
    // run_command with no argv, edit_file with no files, and any other tool.
    expect(permissionCacheScope(req("run_command"))).toBeUndefined();
    expect(permissionCacheScope(req("edit_file"))).toBeUndefined();
    expect(
      permissionCacheScope(req("read_file", { files: ["x"] })),
    ).toBeUndefined();
  });

  it("excludes generic interpreters/shells from caching (a python remember must not cover python -c, audit T3.4 review)", () => {
    const rc = (argv: string[]) =>
      permissionCacheScope(
        req("run_command", {
          call: { id: "c", tool: "run_command", input: { argv } },
        }),
      );
    // argv[0] that does not constrain the executed code → non-cacheable.
    expect(rc(["python", "build.py"])).toBeUndefined();
    expect(rc(["python3", "x.py"])).toBeUndefined();
    expect(rc(["node", "s.js"])).toBeUndefined();
    expect(rc(["bash", "-c", "echo hi"])).toBeUndefined();
    expect(rc(["/usr/bin/perl", "s.pl"])).toBeUndefined();
    expect(rc(["C:\\Python\\python.exe", "x.py"])).toBeUndefined();
    // A specific tool binary still caches under its name.
    expect(rc(["pytest"])).toBe("pytest");
    expect(rc(["npm", "run", "build"])).toBe("npm");
  });
});
