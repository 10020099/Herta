/**
 * The host's automatic dream pass, with the pass itself stubbed: what the
 * host hands it for the session open in the window (ADR 0069 §2), and what
 * it tells that session once the pass is done (ADR 0069 §1b).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TerminalRecordBlock, V2RecordPersister } from "@herta/core";
import { writeRecapCache } from "@herta/herta";
import type { DreamSessionInput, RunDreamPassResult } from "@herta/knowledge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImpl } from "./session.js";
import { createSessionHost } from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig } from "./types.js";

const pass = vi.hoisted(() => ({
  inputs: [] as DreamSessionInput[],
  lockBusy: false,
}));

vi.mock("@herta/knowledge", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@herta/knowledge")>();
  return {
    ...orig,
    runDreamPass: vi.fn(
      async (opts: {
        sessions: readonly DreamSessionInput[];
      }): Promise<RunDreamPassResult> => {
        pass.inputs.push(...opts.sessions);
        return {
          promoted: 0,
          archived: 0,
          skipped: 0,
          considered: 0,
          reinforced: 0,
          reconsolidated: 0,
          echoReinforced: 0,
          seedsEvicted: 0,
          ...(pass.lockBusy ? { lockBusy: true } : {}),
        };
      },
    ),
  };
});

const tmpDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  pass.inputs = [];
  pass.lockBusy = false;
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
});

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-app-server-dream-pass-"));
  tmpDirs.push(root);
  return {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "sk-test",
      actorModel: "deepseek-v4-base",
      backendModel: "deepseek-v4-chat",
      routerModel: "deepseek-flash",
    },
  };
}

/** Three exchanges: user blocks at 0, 2 and 4. */
function writeSession(cfg: AppServerConfig, sessionId: string): void {
  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });
  const blocks: TerminalRecordBlock[] = [
    { kind: "user", text: "一" },
    { kind: "herta", surface: "speech", text: "嗯。" },
    { kind: "user", text: "二" },
    { kind: "herta", surface: "speech", text: "嗯。" },
    { kind: "user", text: "三" },
    { kind: "herta", surface: "speech", text: "嗯。" },
  ];
  for (const b of blocks) persister.appendBlock(b);
}

function runPass(host: unknown): Promise<void> {
  return (
    host as { runDreamPassDetached(): Promise<void> }
  ).runDreamPassDetached();
}

function dreamable(input: DreamSessionInput | undefined): number | undefined {
  if (input === undefined) throw new Error("session not handed to the pass");
  const record =
    typeof input.record === "function" ? input.record() : input.record;
  return input.dreamableEnd?.(record);
}

describe("the host's dream pass and the open session (ADR 0069)", () => {
  it("dreams the open session only behind its recap boundary, and a closed one whole (§2)", async () => {
    const cfg = mkConfig();
    writeSession(cfg, "open-1");
    writeSession(cfg, "closed-1");
    // The open session's prompt compressed its first exchange.
    writeRecapCache(cfg.workspaceRoot, "open-1", {
      boundaryIndex: 2,
      recapText: "recap",
      lang: "zh",
      advancesSinceRederive: 0,
    });
    const host = createSessionHost(cfg);
    await host.openSession({ sessionId: "open-1" });
    await runPass(host);
    const open = pass.inputs.find((s) => s.sessionId === "open-1");
    const closed = pass.inputs.find((s) => s.sessionId === "closed-1");
    expect(dreamable(open)).toBe(2);
    expect(dreamable(closed)).toBeUndefined();
    // Judged when the pass loads the record: once the window closes the
    // session, it dreams as a closed one.
    await host.closeActiveSession();
    expect(dreamable(open)).toBeUndefined();
    host.dispose();
  });

  it("an open session with no recap yet has nothing dreamable (§2)", async () => {
    const cfg = mkConfig();
    writeSession(cfg, "open-1");
    const host = createSessionHost(cfg);
    await host.openSession({ sessionId: "open-1" });
    await runPass(host);
    expect(dreamable(pass.inputs.find((s) => s.sessionId === "open-1"))).toBe(
      0,
    );
    await host.closeActiveSession();
    host.dispose();
  });

  it("tells the open session its prefix is stale after a pass, and not after one that could not take the lock (§1b)", async () => {
    const cfg = mkConfig();
    writeSession(cfg, "open-1");
    const host = createSessionHost(cfg);
    await host.openSession({ sessionId: "open-1" });
    const stale = vi.spyOn(SessionImpl.prototype, "markPrefixStale");
    await runPass(host);
    expect(stale).toHaveBeenCalledTimes(1);
    pass.lockBusy = true;
    await runPass(host);
    expect(stale).toHaveBeenCalledTimes(1);
    await host.closeActiveSession();
    host.dispose();
  });
});
