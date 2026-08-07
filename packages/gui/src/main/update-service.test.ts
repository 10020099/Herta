import type { AppUpdater } from "electron-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../renderer/ipc/bridge-types.js";
import { createUpdateService } from "./update-service.js";

/** Minimal fake AppUpdater: captures handlers, lets tests fire events. */
function mkUpdater(opts: { checkRejects?: Error } = {}): {
  updater: AppUpdater;
  fire: (event: string, payload?: unknown) => void;
  quitAndInstall: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (p: unknown) => void>();
  const quitAndInstall = vi.fn();
  const checkForUpdates = vi.fn(async () => {
    if (opts.checkRejects !== undefined) throw opts.checkRejects;
    return null;
  });
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: vi.fn(),
    on: (event: string, cb: (p: unknown) => void) => {
      handlers.set(event, cb);
    },
    removeAllListeners: vi.fn(),
    checkForUpdates,
    quitAndInstall,
  } as unknown as AppUpdater;
  return {
    updater,
    fire: (event, payload) => handlers.get(event)?.(payload),
    quitAndInstall,
    checkForUpdates,
  };
}

describe("createUpdateService", () => {
  beforeEach(() => vi.useRealTimers());

  it("maps updater events to renderer states (available → downloading → ready)", () => {
    const { updater, fire } = mkUpdater();
    const states: UpdateState[] = [];
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: (s) => states.push(s),
    });
    svc.start();
    fire("checking-for-update");
    fire("update-available", { version: "0.2.0" });
    fire("download-progress", { percent: 41.7 });
    fire("update-downloaded", { version: "0.2.0" });
    expect(states.map((s) => s.phase)).toEqual([
      "checking",
      "available",
      "downloading",
      "ready",
    ]);
    expect(states[1]?.version).toBe("0.2.0");
    expect(states[2]?.progress).toBe(42);
    expect(svc.current().phase).toBe("ready");
    svc.dispose();
  });

  it("restartAndInstall fires quitAndInstall ONLY from ready", () => {
    const { updater, fire, quitAndInstall } = mkUpdater();
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: () => undefined,
    });
    svc.start();
    svc.restartAndInstall();
    expect(quitAndInstall).not.toHaveBeenCalled();
    fire("update-downloaded", { version: "0.2.0" });
    svc.restartAndInstall();
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    svc.dispose();
  });

  it("an AUTOMATIC check failure stays silent (idle), a MANUAL one surfaces error", async () => {
    // The feed is a private repo until launch (404s) and users go offline —
    // automatic checks must never nag. Only the Settings button reports.
    const { updater, fire } = mkUpdater();
    const states: UpdateState[] = [];
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: (s) => states.push(s),
    });
    svc.start();
    // Automatic path: the updater emits "error".
    fire("error", new Error("HttpError: 404"));
    expect(states[states.length - 1]?.phase).toBe("idle");
    // Manual path: the same error surfaces.
    const manual = svc.checkNow();
    fire("error", new Error("HttpError: 404"));
    await manual;
    expect(states[states.length - 1]?.phase).toBe("error");
    expect(states[states.length - 1]?.message).toContain("404");
    svc.dispose();
  });

  it("a manual check that fails DURING the download still surfaces the error (audit finding 8)", async () => {
    // Pre-fix `manualCheck` reset when checkForUpdates() resolved (metadata
    // fetched) — before the autoDownload it kicked off finished. A download
    // error then took the silent branch and the user who had just watched
    // "available v0.2.0 → downloading 30%" was told 已是最新 (idle).
    const { updater, fire } = mkUpdater();
    const states: UpdateState[] = [];
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: (s) => states.push(s),
    });
    svc.start();
    const manual = svc.checkNow();
    fire("checking-for-update");
    fire("update-available", { version: "0.2.0" });
    await manual; // metadata promise settles — the download is still running
    fire("download-progress", { percent: 30 });
    fire("error", new Error("net::ERR_CONNECTION_RESET"));
    expect(states[states.length - 1]?.phase).toBe("error");
    expect(states[states.length - 1]?.message).toContain("CONNECTION_RESET");
    svc.dispose();
  });

  it("the manual latch clears at a terminal phase — a later AUTO error is silent again", async () => {
    const { updater, fire } = mkUpdater();
    const states: UpdateState[] = [];
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: (s) => states.push(s),
    });
    svc.start();
    // Manual flow runs to completion (ready) — the latch must clear there.
    const manual = svc.checkNow();
    fire("update-available", { version: "0.2.0" });
    await manual;
    fire("update-downloaded", { version: "0.2.0" });
    expect(states[states.length - 1]?.phase).toBe("ready");
    // A later automatic failure stays silent (the private-feed 404 case).
    fire("error", new Error("HttpError: 404"));
    expect(states[states.length - 1]?.phase).toBe("idle");
    svc.dispose();
  });

  it("a rejecting checkForUpdates follows the same manual/auto policy", async () => {
    const { updater } = mkUpdater({ checkRejects: new Error("offline") });
    const states: UpdateState[] = [];
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: (s) => states.push(s),
    });
    svc.start();
    await svc.checkNow();
    expect(states[states.length - 1]?.phase).toBe("error");
    expect(states[states.length - 1]?.message).toBe("offline");
    svc.dispose();
  });

  it("dev build without the dry-run feed: no wiring, manual check reports unsupported", async () => {
    const { updater, checkForUpdates } = mkUpdater();
    const states: UpdateState[] = [];
    const svc = createUpdateService({
      updater,
      isPackaged: false,
      send: (s) => states.push(s),
    });
    svc.start();
    await svc.checkNow();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(states[states.length - 1]?.phase).toBe("error");
    svc.dispose();
  });

  it("the dry-run feed override re-enables checks in dev via a generic provider", () => {
    const { updater } = mkUpdater();
    const svc = createUpdateService({
      updater,
      isPackaged: false,
      feedUrlOverride: "http://localhost:8099/updates",
      send: () => undefined,
    });
    svc.start();
    expect(
      (updater as unknown as { setFeedURL: ReturnType<typeof vi.fn> })
        .setFeedURL,
    ).toHaveBeenCalledWith({
      provider: "generic",
      url: "http://localhost:8099/updates",
    });
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    svc.dispose();
  });
});

describe("createUpdateService — automatic-cycle toggle (2026-07-12)", () => {
  it("autoEnabled: false starts with NO launch/interval checks; manual checkNow still works", async () => {
    vi.useFakeTimers();
    const { updater, checkForUpdates } = mkUpdater();
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      autoEnabled: false,
      send: () => {},
    });
    svc.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000); // past launch + interval
    expect(checkForUpdates).not.toHaveBeenCalled();
    await svc.checkNow(); // user-initiated = consent, works regardless
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    svc.dispose();
    vi.useRealTimers();
  });

  it("setAutoEnabled(false) mid-run cancels the cycle; (true) checks once and resumes it", async () => {
    vi.useFakeTimers();
    const { updater, checkForUpdates } = mkUpdater();
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      send: () => {},
    });
    svc.start();
    await vi.advanceTimersByTimeAsync(16_000); // launch check fires
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    svc.setAutoEnabled(false);
    await vi.advanceTimersByTimeAsync(9 * 60 * 60 * 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1); // cycle cancelled
    svc.setAutoEnabled(true);
    expect(checkForUpdates).toHaveBeenCalledTimes(2); // immediate re-enable check
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 1000);
    expect(checkForUpdates).toHaveBeenCalledTimes(3); // interval resumed
    svc.dispose();
    vi.useRealTimers();
  });

  it("setAutoEnabled before start() is only a value change (start applies it)", async () => {
    vi.useFakeTimers();
    const { updater, checkForUpdates } = mkUpdater();
    const svc = createUpdateService({
      updater,
      isPackaged: true,
      autoEnabled: false,
      send: () => {},
    });
    svc.setAutoEnabled(true); // before start: no timers yet, no check
    expect(checkForUpdates).not.toHaveBeenCalled();
    svc.start();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(checkForUpdates).toHaveBeenCalledTimes(1); // start honored the value
    svc.dispose();
    vi.useRealTimers();
  });
});
