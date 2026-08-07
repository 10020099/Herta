import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { setVoiceMuted } from "../../voice/voice-prefs.js";
import { SettingsModal } from "./SettingsModal.js";

/** Wrap in a mock bridge provider: the modal opens on the Language pane,
 *  whose interaction-language row reads the bridge (slice 4). */
function wrap(ui: JSX.Element): JSX.Element {
  return (
    <HertaBridgeProvider bridge={createMockHertaBridge().bridge}>
      {ui}
    </HertaBridgeProvider>
  );
}

describe("SettingsModal", () => {
  afterEach(() => setVoiceMuted(false));

  it("renders nothing when closed", () => {
    const { queryByRole } = renderWithLocale(
      wrap(<SettingsModal open={false} onClose={() => {}} />),
    );
    expect(queryByRole("dialog")).toBeNull();
  });

  it("renders the dialog when open and focuses it", () => {
    const { getByRole } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    const dialog = getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
  });

  it("does NOT steal focus to the Settings button on initial mount (closed)", () => {
    const btn = document.createElement("button");
    btn.className = "sidebar-settings";
    document.body.appendChild(btn);
    renderWithLocale(wrap(<SettingsModal open={false} onClose={() => {}} />));
    expect(document.activeElement).not.toBe(btn);
    btn.remove();
  });

  it("restores focus to the Settings button after a real open→close", () => {
    const btn = document.createElement("button");
    btn.className = "sidebar-settings";
    document.body.appendChild(btn);
    const { rerender } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    rerender(wrap(<SettingsModal open={false} onClose={() => {}} />));
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  it("re-opens on the first section (Language), not the last-viewed one", () => {
    const mock = createMockHertaBridge();
    const ui = (open: boolean): JSX.Element => (
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={open} onClose={() => {}} />
      </HertaBridgeProvider>
    );
    const { getByRole, rerender } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    // Switch to a non-default section.
    fireEvent.click(getByRole("button", { name: "DeepSeek" }));
    expect(getByRole("heading", { name: "DeepSeek" })).toBeTruthy();
    // Close, then reopen — it should be back on Language, not DeepSeek.
    // Note: rerender replaces the whole tree, so wrap in the full provider stack.
    rerender(ui(false));
    rerender(ui(true));
    expect(getByRole("heading", { name: "Language" })).toBeTruthy();
  });

  it("groups the nav under 通用/黑塔/引擎 labels (General, Herta, Engine)", () => {
    const { getByText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    expect(getByText("General")).toBeTruthy();
    expect(getByText("Herta")).toBeTruthy();
    expect(getByText("Engine")).toBeTruthy();
  });

  it("includes a Window section with the close-to-tray toggle wired to the bridge", async () => {
    const mock = createMockHertaBridge();
    const { getByRole, findByLabelText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Window" }));
    const toggle = await findByLabelText("Close to tray");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // default ON
    fireEvent.click(toggle);
    expect(mock.calls.setCloseToTray).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("includes a Coprocessor section that switches to its pane", () => {
    const { getByRole } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    fireEvent.click(getByRole("button", { name: "Coprocessor" }));
    expect(getByRole("heading", { name: "Coprocessor" })).toBeTruthy();
  });

  it("renders the Coprocessor delegation trigger as @Brick under the English UI (chrome-consistent, no active session needed)", () => {
    // renderWithLocale defaults to the "en" UI locale; the token follows the UI
    // locale like the surrounding prose, so an all-English panel never shows a
    // lone CJK @板砖 — including with no session active (this pane's common case).
    // Per-locale keying is unit-tested directly in BanzhuanSettings.test.tsx.
    const { container } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    fireEvent.click(screen.getByRole("button", { name: "Coprocessor" }));
    expect(container.querySelector(".settings-intro code")?.textContent).toBe(
      "@Brick",
    );
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderWithLocale(wrap(<SettingsModal open={true} onClose={onClose} />));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape with a Select dropdown open closes ONLY the dropdown; a second Escape closes the modal", () => {
    // Pre-fix, one Escape closed the dropdown AND the whole modal because both
    // document keydown listeners fired (adversarial review 2026-07-15). The
    // open Select now owns the topmost overlay, so the modal defers.
    const onClose = vi.fn();
    renderWithLocale(wrap(<SettingsModal open={true} onClose={onClose} />));
    const trigger = screen.getByLabelText("Display language");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // First Escape: dropdown closes, modal stays.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    // Second Escape: nothing above the modal now, so it closes.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside (backdrop) mousedown, not an inside one", () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={onClose} />),
    );
    fireEvent.mouseDown(getByRole("dialog")); // inside the card
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body); // outside
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close button calls onClose", () => {
    const onClose = vi.fn();
    const { getByLabelText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={onClose} />),
    );
    fireEvent.click(getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus within the modal", () => {
    const { getByRole, getByLabelText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    const navItem = getByRole("button", { name: "Language" }); // first focusable
    // Last focusable (Language pane): the interaction-language Select's
    // trigger button (slice 4 — it sits below the UI-language row).
    const trigger = getByLabelText("Interaction language");
    // Tab on the last wraps to the first.
    trigger.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(navItem);
    // Shift+Tab on the first wraps to the last.
    navItem.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the Voice section's mute toggle", () => {
    const { getByRole, getByLabelText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    fireEvent.click(getByRole("button", { name: "Voice" }));
    expect(getByLabelText("Mute voice").getAttribute("role")).toBe("switch");
  });

  it("shows a Language section that switches locale live (custom Select)", () => {
    renderWithLocale(wrap(<SettingsModal open onClose={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    // The custom Select: trigger opens the popover, picking 中文 applies live.
    const trigger = screen.getByLabelText("Display language");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "中文" }));
    expect(screen.getByText("设置")).toBeInTheDocument(); // eyebrow flips to zh
  });
});
