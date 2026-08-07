import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { OVERLAY_Z, popOverlay, pushOverlay } from "../../lib/overlay-stack.js";
import { ApprovalPanel } from "./ApprovalPanel.js";

function setup(): MockHertaBridge {
  const mock = createMockHertaBridge();
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <ApprovalPanel />
    </HertaBridgeProvider>,
  );
  return mock;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function emitPending(mock: MockHertaBridge): void {
  act(() => {
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "req-9",
        risk: "network",
        tool: "run_command",
        summary: "install a package",
        command: "npm install left-pad",
        cacheable: true,
      },
    });
  });
}

describe("ApprovalPanel", () => {
  afterEach(() => vi.useRealTimers());

  it("renders nothing when there is no pending overlay", async () => {
    setup();
    await settle();
    expect(screen.queryByTestId("approval-panel")).not.toBeInTheDocument();
  });

  it("shows the request detail when a permission is pending", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(screen.getByText("Permission request")).toBeInTheDocument();
    expect(screen.getByText("install a package")).toBeInTheDocument();
    expect(screen.getByText("npm install left-pad")).toBeInTheDocument();
    expect(screen.getByText("Network access")).toBeInTheDocument();
  });

  it("Allow resolves allow/once", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "once" },
    ]);
  });

  it("Always allow resolves allow/session", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for this task" }),
    );
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "session" },
    ]);
  });

  it("Allow in project resolves allow/always and names the exact rule (ADR 0030)", async () => {
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-pr",
          risk: "workspace_write",
          tool: "run_command",
          summary: "interpreter runs a script",
          command: "node src/index.mjs sample.txt",
          cacheable: false,
          projectRule: "node src/index.mjs:*",
        },
      });
    });
    // The dim note spells out the exact grant before the user commits.
    expect(
      screen.getByText("“Allow in project” remembers: node src/index.mjs:*"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow in project" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-pr", decision: "allow", persistence: "always" },
    ]);
  });

  it("hides Allow in project when no rule is derivable", async () => {
    // resolveExternal would silently no-op an "always" persist for a request
    // that derives no rule (node -e, shells, non-eligible ask classes) — the
    // button is withheld rather than offered-and-ignored, same contract as
    // the cacheable gate below.
    const mock = setup();
    await settle();
    emitPending(mock); // fixture carries no projectRule
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow in project" }),
    ).not.toBeInTheDocument();
  });

  it("hides Always allow when the request is not cacheable", async () => {
    // OverlayAskResolver.resolveExternal would silently drop a "session"
    // choice for a non-cacheable request (network-risk / generic-interpreter
    // run_command, undefined scope), so the identical request re-prompts next
    // turn. The button is withheld rather than offered-and-ignored (audit T3.4
    // follow-up; mirrors the CLI showRemember gate).
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-nc",
          risk: "network",
          tool: "run_command",
          summary: "run an arbitrary script",
          command: "python build.py",
          cacheable: false,
        },
      });
    });
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow for this task" }),
    ).not.toBeInTheDocument();
    // The real (once) and deny paths are unaffected.
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("hides Always allow when cacheability is unknown (legacy overlay)", async () => {
    // Absent flag → treated as not cacheable (fail-safe): the button never
    // appears for a choice that might silently no-op.
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-legacy",
          risk: "workspace_read",
          tool: "run_command",
          summary: "no cacheable flag",
          command: "echo hi",
        },
      });
    });
    expect(
      screen.queryByRole("button", { name: "Allow for this task" }),
    ).not.toBeInTheDocument();
  });

  it("Deny resolves deny", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "deny" },
    ]);
  });

  it("Escape resolves deny", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "deny" },
    ]);
  });

  it("ignores an Escape that originated in another focused element (audit 2026-07-24 H2)", async () => {
    // Opening the sidebar search over a pending gate and pressing Escape to
    // close it silently DENIED the permission: the panel's window listener
    // treated any Escape as deny, and the search field neither registers on
    // the overlay stack nor stopped propagation. The panel now origin-tests.
    const mock = setup();
    await settle();
    emitPending(mock);
    const outsider = document.createElement("input");
    document.body.appendChild(outsider);
    try {
      outsider.focus();
      fireEvent.keyDown(outsider, { key: "Escape", bubbles: true });
      expect(mock.calls.resolveApproval).toEqual([]);
      // ...while an Escape from inside the panel still denies.
      fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
        key: "Escape",
        bubbles: true,
      });
      expect(mock.calls.resolveApproval).toEqual([
        { requestId: "req-9", decision: "deny" },
      ]);
    } finally {
      outsider.remove();
    }
  });

  it("yields Escape and autofocus to a covering overlay (e.g. Settings)", async () => {
    // Another overlay (Settings, key prompt, a card menu) sits ABOVE the
    // panel on the modal stack: Escape must NOT silently deny the invisible
    // request, and the panel must not steal keyboard focus from the modal.
    pushOverlay("settings", OVERLAY_Z.settings);
    try {
      const mock = setup();
      await settle();
      emitPending(mock);
      // No focus steal: the Allow button did not take focus.
      expect(document.activeElement).not.toBe(
        screen.getByRole("button", { name: "Allow" }),
      );
      fireEvent.keyDown(window, { key: "Escape" });
      expect(mock.calls.resolveApproval).toEqual([]);
    } finally {
      popOverlay("settings");
    }
  });

  it("regains focus (and Escape) when the covering overlay closes", async () => {
    pushOverlay("settings", OVERLAY_Z.settings);
    const mock = setup();
    await settle();
    emitPending(mock);
    expect(mock.calls.resolveApproval).toEqual([]);
    act(() => {
      popOverlay("settings");
    });
    // Now topmost: focus lands on Allow, and Escape denies.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Allow" }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "deny" },
    ]);
  });

  it("traps Tab inside the panel while a gate is pending (audit finding 9)", async () => {
    // Pre-fix Shift+Tab walked out of the panel into the suppressed
    // composer's invisible-but-enabled stop button, where Enter aborted the
    // gated turn — the same teardown mainNavigationBlock exists to prevent.
    const mock = setup();
    await settle();
    emitPending(mock);
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });
    // Autofocus put us on Allow (the first focusable). Shift+Tab from the
    // FIRST button wraps to the LAST — never out of the panel.
    expect(document.activeElement).toBe(allow);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(deny);
    // Tab from the LAST wraps back to the FIRST.
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(allow);
    // Focus stranded OUTSIDE the panel (e.g. on body) is clamped back in.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(allow);
    expect(mock.calls.resolveApproval).toEqual([]);
  });

  it("does not trap Tab while a covering overlay is on top", async () => {
    pushOverlay("settings", OVERLAY_Z.settings);
    try {
      const mock = setup();
      await settle();
      emitPending(mock);
      const before = document.activeElement;
      fireEvent.keyDown(window, { key: "Tab" });
      // The panel's handler is not even attached below a covering modal —
      // focus is wherever the modal put it, untouched by us.
      expect(document.activeElement).toBe(before);
      expect(mock.calls.resolveApproval).toEqual([]);
    } finally {
      popOverlay("settings");
    }
  });

  it("latches after the first resolution — no double resolve from clicks or Escape", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    const allow = screen.getByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    // Second click, a contradictory Deny click, and Escape key-repeat all land
    // before the `resolved` event round-trips — none may send a second call.
    fireEvent.click(allow);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "once" },
    ]);
  });

  it("a FRESH request re-arms the latch", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-10",
          risk: "network",
          tool: "run_command",
          summary: "another",
          command: "npm test",
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "once" },
      { requestId: "req-10", decision: "deny" },
    ]);
  });

  it("animates out and unmounts when the overlay resolves", async () => {
    vi.useFakeTimers();
    const mock = setup();
    await act(async () => {
      await Promise.resolve();
    });
    emitPending(mock);
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    act(() => {
      mock.emitOverlay({ kind: "resolved", requestId: "req-9" });
    });
    // is-out during the exit window, then removed after EXIT_MS.
    expect(screen.getByTestId("approval-panel").className).toContain("is-out");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByTestId("approval-panel")).not.toBeInTheDocument();
  });
});

describe("ApprovalPanel — conversation reserve (2026-07-27)", () => {
  // The panel is absolute at the footer's bottom and taller than the footer,
  // so its top reaches over the conversation; the reserve keeps streaming
  // content (Herta's beat about the very gate) above it instead of under it.
  afterEach(() => vi.useRealTimers());

  /** jsdom has no layout: stub offsetHeight so the overhang math has inputs.
   *  offsetParent is always null in jsdom, so the footer term reads 0 and the
   *  published reserve equals the panel's stubbed height. */
  function stubOffsetHeight(px: number): () => void {
    const proto = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    Object.defineProperty(proto, "offsetHeight", {
      configurable: true,
      get: () => px,
    });
    return () => {
      if (original !== undefined) {
        Object.defineProperty(proto, "offsetHeight", original);
      }
    };
  }

  function setupInWorkspace(): {
    mock: MockHertaBridge;
    workspace: () => HTMLElement;
  } {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <main className="workspace" data-testid="ws">
        <HertaBridgeProvider bridge={mock.bridge}>
          <ApprovalPanel />
        </HertaBridgeProvider>
      </main>,
    );
    return { mock, workspace: () => screen.getByTestId("ws") };
  }

  it("publishes the overhang as --approval-reserve while the gate is open", async () => {
    const restore = stubOffsetHeight(232);
    try {
      const { mock, workspace } = setupInWorkspace();
      await settle();
      emitPending(mock);
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe(
        "232px",
      );
    } finally {
      restore();
    }
  });

  it("clears the reserve the moment the exit STARTS", async () => {
    vi.useFakeTimers();
    const restore = stubOffsetHeight(232);
    try {
      const { mock, workspace } = setupInWorkspace();
      await act(async () => {
        await Promise.resolve();
      });
      emitPending(mock);
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe(
        "232px",
      );
      act(() => {
        mock.emitOverlay({ kind: "resolved", requestId: "req-9" });
      });
      // `leaving` — the conversation relaxes down behind the fading panel.
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe("");
    } finally {
      restore();
    }
  });

  it("a zero/negative overhang publishes nothing (panel shorter than footer)", async () => {
    const restore = stubOffsetHeight(0);
    try {
      const { mock, workspace } = setupInWorkspace();
      await settle();
      emitPending(mock);
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe("");
    } finally {
      restore();
    }
  });

  it("without a .workspace ancestor the panel still works (fakes, previews)", async () => {
    const restore = stubOffsetHeight(232);
    try {
      const mock = setup();
      await settle();
      emitPending(mock);
      expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  describe("what a screen reader is told (audit S13)", () => {
    it("announces the summary and the literal command, not just the title", async () => {
      const mock = setup();
      await settle();
      emitPending(mock);
      const panel = screen.getByTestId("approval-panel");

      expect(panel).toHaveAttribute("aria-modal", "true");
      const describedBy = panel.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();

      // The whole announced string used to be "Permission request. Allow,
      // button." — focus is moved programmatically past the summary and the
      // command, so unless they are the dialog's DESCRIPTION they are never
      // read. This is the one place in the product where the user, not the
      // harness, decides (D4); approving a command you were not told about
      // is the failure being prevented.
      const desc = document.getElementById(describedBy as string);
      expect(desc).not.toBeNull();
      expect(desc?.textContent).toContain("install a package");
      expect(desc?.textContent).toContain("npm install left-pad");
    });

    it("the diff disclosure says what it does, not just what the diff is", async () => {
      const mock = setup();
      await settle();
      act(() => {
        mock.emitOverlay({
          kind: "pending",
          overlay: {
            kind: "pending-permission",
            requestId: "req-diff",
            risk: "workspace_write",
            tool: "edit_file",
            summary: "edit a file",
            diff: "@@ -1 +1 @@\n-a\n+b\n",
            cacheable: false,
          },
        });
      });
      // Content-derived, its name was "▸ 展开 差异 …" — the glyph plus a
      // description of the diff, with no verb.
      const toggle = screen.getByRole("button", { name: /show the diff/i });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveAttribute("aria-controls", "approval-panel-diff");

      fireEvent.click(toggle);
      expect(
        screen.getByRole("button", { name: /hide the diff/i }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById("approval-panel-diff")).not.toBeNull();
    });
  });
});
