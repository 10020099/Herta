import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  TodoStore,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { listFilesTool } from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctx(workspaceRoot: string, reads = new ReadLedger()) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads,
    todos: new TodoStore(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}
const noopProgress = () => {};

describe("listFilesTool", () => {
  it("throws AbortError on an aborted signal (audit M4: interrupt, not read_failed)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "1" });
    const tool = listFilesTool();
    const ac = new AbortController();
    ac.abort();
    // The walk's AbortError must escape the read_failed catch — the turn
    // loop classifies it as `interrupted`.
    await expect(
      tool.run(
        { id: "1", tool: "list_files", input: { path: "." } },
        { ...ctx(ws.root), signal: ac.signal },
        noopProgress,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("lists direct children when not recursive", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "1",
      "b.txt": "2",
      "sub/c.txt": "3",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: { path: "." } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      entries: { path: string; type: string }[];
      truncated: boolean;
    };
    expect(data.entries.map((e) => e.path).sort()).toEqual([
      "a.txt",
      "b.txt",
      "sub",
    ]);
    expect(data.truncated).toBe(false);
  });

  it("recurses when recursive: true", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "1",
      "sub/b.txt": "2",
      "sub/deep/c.txt": "3",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "list_files",
        input: { path: ".", recursive: true },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { entries: { path: string }[] };
    const paths = data.entries.map((e) => e.path);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub");
    expect(paths).toContain("sub/b.txt");
    expect(paths).toContain("sub/deep");
    expect(paths).toContain("sub/deep/c.txt");
  });

  it("omits skip-list directories and reports them", async () => {
    ws = await mkTmpWorkspace({
      "src/foo.ts": "x",
      "node_modules/lib/index.js": "y",
      ".git/HEAD": "z",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "list_files",
        input: { path: ".", recursive: true },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      entries: { path: string }[];
      skipped: string[];
    };
    const paths = data.entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(data.skipped.sort()).toEqual([".git", "node_modules"]);
  });

  it("truncates when maxEntries is reached", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "1",
      "b.txt": "2",
      "c.txt": "3",
      "d.txt": "4",
      "e.txt": "5",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "list_files",
        input: { path: ".", maxEntries: 3 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { entries: unknown[]; truncated: boolean };
    expect(data.entries).toHaveLength(3);
    expect(data.truncated).toBe(true);
    expect(r.summary).toContain("truncated");
  });

  it("classifies directories as type: dir", async () => {
    ws = await mkTmpWorkspace({
      "file.txt": "x",
      "sub/inner.txt": "y",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: { path: "." } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { entries: { path: string; type: string }[] };
    const sub = data.entries.find((e) => e.path === "sub");
    const file = data.entries.find((e) => e.path === "file.txt");
    expect(sub?.type).toBe("dir");
    expect(file?.type).toBe("file");
  });

  it("returns invalid_input when path is a file, not a directory", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "1" });
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: { path: "a.txt" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(r.error?.message).toContain("not a directory");
  });

  it("defaults path to '.' when omitted", async () => {
    ws = await mkTmpWorkspace({ "x.txt": "x" });
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: {} },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { entries: { path: string }[] };
    expect(data.entries.map((e) => e.path)).toContain("x.txt");
  });

  it("returns not_found for nonexistent path", async () => {
    ws = await mkTmpWorkspace({});
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: { path: "nope" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_found");
  });

  it("denies a path outside the workspace", async () => {
    ws = await mkTmpWorkspace({});
    const tool = listFilesTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "list_files",
        input: { path: "../../etc" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("path_outside_workspace");
  });

  it("sorts entries alphabetically", async () => {
    ws = await mkTmpWorkspace({
      "zeta.txt": "1",
      "alpha.txt": "2",
      "mu.txt": "3",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: { path: "." } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { entries: { path: string }[] };
    const paths = data.entries.map((e) => e.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("exposes JSON Schema via schema()", async () => {
    const tool = listFilesTool();
    const schema = tool.schema();
    expect(schema.name).toBe("list_files");
    expect(schema.description.length).toBeGreaterThan(0);
    expect(schema.inputSchema).toBeDefined();
  });

  it("omits credential-denylisted names from listings (audit finding 1)", async () => {
    ws = await mkTmpWorkspace({
      ".env": "SECRET=1\n",
      ".env.example": "SECRET=\n",
      id_rsa: "key\n",
      "certs/server.pem": "pem\n",
      "README.md": "hi\n",
    });
    const tool = listFilesTool();
    const r = await tool.run(
      { id: "1", tool: "list_files", input: { recursive: true } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { entries: { path: string }[] };
    const paths = data.entries.map((e) => e.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain(".env.example");
    expect(paths).toContain("certs");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("id_rsa");
    expect(paths).not.toContain("certs/server.pem");
  });
});
