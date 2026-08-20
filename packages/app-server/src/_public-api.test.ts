import { describe, expect, it } from "vitest";
import * as appServer from "./index.js";

describe("@herta/app-server — public API surface", () => {
  it("exports exactly the documented runtime symbols", () => {
    const runtimeKeys = Object.keys(appServer).sort();
    expect(runtimeKeys).toEqual(
      [
        "createSessionHost",
        "defaultDirsFor",
        "loadMcpConfig",
        "mcpConfigPath",
        "parseMcpConfig",
        "parseMcpServerConfig",
        // Long-session windowing (2026-07-12): the shared tail-slice helper
        // used by every full-record payload to the renderer.
        "RECORD_TAIL_BLOCKS",
        "recordTail",
        "writeMcpConfig",
      ].sort(),
    );
  });

  it("does NOT export internal seams or test helpers", () => {
    const keys = Object.keys(appServer);
    expect(keys).not.toContain("SessionImpl");
    expect(keys).not.toContain("SessionEventProjector");
    expect(keys).not.toContain("OverlayAskResolver");
    expect(keys).not.toContain("stubCompletionProvider");
    expect(keys).not.toContain("stubChatProvider");
  });
});
