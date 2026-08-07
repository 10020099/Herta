import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { useOverlay } from "./useOverlay.js";

describe("useOverlay", () => {
  it("returns null when no overlay is active", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useOverlay(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    expect(result.current).toBeNull();
  });

  it("reflects the overlay from the active session after reset", () => {
    const mock = createMockHertaBridge();
    const { result } = renderHook(() => useOverlay(), {
      wrapper: ({ children }) => (
        <HertaBridgeProvider bridge={mock.bridge}>
          {children}
        </HertaBridgeProvider>
      ),
    });
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    expect(result.current).toBeNull();
  });
});
