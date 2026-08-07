import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridgeOpts,
} from "../../ipc/mock-bridge.js";
import { LanguageSettings } from "./LanguageSettings.js";

function setup(opts: MockHertaBridgeOpts = {}) {
  const mock = createMockHertaBridge(opts);
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <LanguageSettings />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("LanguageSettings — interaction-language row (slice 4)", () => {
  it("renders the interaction row next to the UI-language row", () => {
    setup();
    expect(screen.getByLabelText("Display language")).toBeInTheDocument();
    expect(screen.getByLabelText("Interaction language")).toBeInTheDocument();
    // The description says it applies to NEW sessions and that EN sessions
    // have no voice this release.
    expect(
      screen.getByText(
        "The language Herta talks with you in. Applies to new sessions; English sessions have no voice in this release.",
      ),
    ).toBeInTheDocument();
  });

  it("defaults to Follow UI language and loads a stored choice", async () => {
    setup({ interactionLanguageResult: "en" });
    // The stored "en" loads async and replaces the "follow" default.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Interaction language").textContent,
      ).toContain("English"),
    );
  });

  it("persists a picked language through the bridge", async () => {
    const mock = setup();
    await waitFor(() =>
      expect(mock.calls.getInteractionLanguage).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByLabelText("Interaction language"));
    fireEvent.click(screen.getByText("中文"));
    expect(mock.calls.setInteractionLanguage).toEqual(["zh"]);
  });

  it('persists "follow" (deletes the stored field server-side)', async () => {
    const mock = setup({ interactionLanguageResult: "en" });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Interaction language").textContent,
      ).toContain("English"),
    );
    fireEvent.click(screen.getByLabelText("Interaction language"));
    fireEvent.click(screen.getByText("Follow UI language"));
    expect(mock.calls.setInteractionLanguage).toEqual(["follow"]);
  });

  it("snaps back and shows an error note when the write fails", async () => {
    const mock = setup({ failSetInteractionLanguage: true });
    await waitFor(() =>
      expect(mock.calls.getInteractionLanguage).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByLabelText("Interaction language"));
    fireEvent.click(screen.getByText("中文"));
    // The failed persist reverts the optimistic pick to the "follow" default.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Interaction language").textContent,
      ).toContain("Follow UI language"),
    );
    expect(mock.calls.setInteractionLanguage).toEqual(["zh"]);
    expect(screen.getByText("Couldn't save — try again.")).toBeInTheDocument();
  });
});
