import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { ProviderSettings } from "./ProviderSettings.js";

function configuredBridge(models: readonly string[] = []): {
  readonly mock: ReturnType<typeof createMockHertaBridge>;
  readonly bridge: HertaBridge;
} {
  const mock = createMockHertaBridge({ providerModels: models });
  const bridge: HertaBridge = {
    ...mock.bridge,
    getProviderStatus: async (type) => ({
      type,
      set: true,
      hint: "1234",
      encrypted: true,
      baseUrl: "https://api.example.com/v1",
      actorModel: "model-current",
      backendModel: "model-current",
    }),
  };
  return { mock, bridge };
}

function renderPane(bridge: HertaBridge): ReturnType<typeof renderWithLocale> {
  return renderWithLocale(
    <HertaBridgeProvider bridge={bridge}>
      <ProviderSettings />
    </HertaBridgeProvider>,
  );
}

describe("ProviderSettings model discovery", () => {
  it("fetches model IDs then uses the Coprocessor-style Select for each model role", async () => {
    const { mock, bridge } = configuredBridge(["model-z", "model-a"]);
    renderPane(bridge);

    // The status query and its draft-value reset are asynchronous; wait for
    // the saved address before exercising the draft-forwarding contract.
    await screen.findByDisplayValue("https://api.example.com/v1");
    const fetch = await screen.findByRole("button", { name: "Fetch models" });
    fireEvent.click(fetch);
    await waitFor(() =>
      expect(mock.calls.fetchProviderModels).toEqual([
        ["deepseek", "https://api.example.com/v1"],
      ]),
    );

    const actor = await screen.findByLabelText("Herta Model");
    expect(actor.tagName).toBe("BUTTON");
    fireEvent.click(actor);
    fireEvent.click(screen.getByRole("option", { name: "model-a" }));
    expect(actor.textContent).toContain("model-a");
  });

  it("keeps long model IDs inside an inline, scrollable settings menu", async () => {
    const longModel =
      "openrouter/organization/very-long-model-family-with-a-descriptive-release-name-and-reasoning-variant";
    const catalog = [
      longModel,
      ...Array.from({ length: 48 }, (_, index) => `provider/model-${index}`),
    ];
    const { bridge } = configuredBridge(catalog);
    renderPane(bridge);

    await screen.findByDisplayValue("https://api.example.com/v1");
    fireEvent.click(
      await screen.findByRole("button", { name: "Fetch models" }),
    );
    const actor = await screen.findByLabelText("Herta Model");
    fireEvent.click(actor);

    const menu = await screen.findByRole("listbox", { name: "Herta Model" });
    await waitFor(() =>
      expect(menu).toHaveClass("settings-select-menu", "is-inline", "is-open"),
    );
    expect(menu.closest(".settings-select-wrap")).toHaveClass("is-inline");
    expect(
      screen.getByRole("option", { name: longModel }).textContent,
    ).toContain(longModel);
  });

  it("keeps manual model inputs available when discovery fails", async () => {
    const mock = createMockHertaBridge({ failFetchProviderModels: true });
    const bridge: HertaBridge = {
      ...mock.bridge,
      getProviderStatus: async (type) => ({
        type,
        set: true,
        hint: "1234",
        encrypted: true,
      }),
    };
    renderPane(bridge);

    fireEvent.click(
      await screen.findByRole("button", { name: "Fetch models" }),
    );
    await screen.findByText(/Could not fetch models/);
    expect(screen.getByDisplayValue("deepseek-v4-pro")).toBeTruthy();
  });
});
