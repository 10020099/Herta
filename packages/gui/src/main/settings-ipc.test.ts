import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceSettingsState } from "./settings-ipc.js";

/**
 * The Settings rows' IPC door, driven with a fake registrar (ADR 0042 §7c:
 * the 实时语音 toggle). `electron` is mocked to the one call the handlers
 * make at this depth — `app.getPath("userData")` — into a temp dir.
 */
const userData = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => userData.dir, isPackaged: false },
}));

const { CMD } = await import("../preload/channels.js");
const { registerSettingsHandlers } = await import("./settings-ipc.js");

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

afterEach(() => {
  if (userData.dir.length > 0) {
    rmSync(userData.dir, { recursive: true, force: true });
    userData.dir = "";
  }
});

describe("settings IPC — 实时语音 off mid-reply (ADR 0042 §7c)", () => {
  it("turning the voice OFF stops the speech in flight; turning it on stops nothing", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const stopSpeech = vi.fn();
    const voice: VoiceSettingsState = {
      synthesizer: null,
      voiceModel: null,
      minimaxVoice: null,
      engine: "local",
      realtimeEnabled: true,
      minimaxFetch: (async () => new Response("")) as never,
      anyMiniMaxKey: () => false,
      minimaxRefusal: () => null,
      stopSpeech,
    };
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice,
    });
    const set = handlers.get(CMD.setRealtimeVoice);
    expect(set).toBeDefined();
    await set?.(null, false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(voice.realtimeEnabled).toBe(false);
    await set?.(null, true);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(voice.realtimeEnabled).toBe(true);
  });
});
