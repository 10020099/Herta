import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { resetThemeForTest } from "../../lib/theme.js";
import { WindowSettings } from "./WindowSettings.js";

afterEach(resetThemeForTest);

function setup(platform?: string) {
  const mock = createMockHertaBridge(
    platform !== undefined ? { platform } : {},
  );
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <WindowSettings />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("WindowSettings appearance row (night-mode slice 2)", () => {
  it("renders the Appearance select alongside close-to-tray", () => {
    setup();
    expect(screen.getByLabelText("Appearance")).toBeInTheDocument();
    expect(screen.getByLabelText("Close to tray")).toBeInTheDocument();
  });

  it("on a Mac the row says menu bar, and does not claim that turning it off quits (2026-09-23)", () => {
    setup("darwin");
    expect(screen.getByLabelText("Close to menu bar")).toBeInTheDocument();
    expect(screen.queryByText(/system tray/)).toBeNull();
    expect(screen.getByText(/stays in the Dock until you quit/)).toBeTruthy();
  });

  it("picking Dark stamps <html data-theme> LIVE and persists via the bridge", () => {
    const mock = setup();
    fireEvent.click(screen.getByLabelText("Appearance"));
    fireEvent.click(screen.getByText("Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(mock.calls.setTheme).toEqual(["dark"]);
  });

  it("picking System resolves via prefers-color-scheme (stub: light)", () => {
    const mock = setup();
    fireEvent.click(screen.getByLabelText("Appearance"));
    fireEvent.click(screen.getByText("System"));
    // The setup-tests matchMedia stub reports matches:false → light.
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(mock.calls.setTheme).toEqual(["system"]);
  });
});
