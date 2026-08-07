import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { resetThemeForTest } from "../../lib/theme.js";
import { WindowSettings } from "./WindowSettings.js";

afterEach(resetThemeForTest);

function setup() {
  const mock = createMockHertaBridge();
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
