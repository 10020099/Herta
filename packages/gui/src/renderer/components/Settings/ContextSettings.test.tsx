import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { ContextSettings } from "./ContextSettings.js";

describe("ContextSettings", () => {
  it("loads the saved level and persists a five-tier threshold choice", async () => {
    const mock = createMockHertaBridge({
      contextCompactionConfig: { level: "low" },
    });
    const { getByLabelText, getByRole, getByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ContextSettings />
      </HertaBridgeProvider>,
    );

    await waitFor(() => expect(mock.calls.getContextCompactionConfig).toBe(1));
    expect(getByText("Low (400k)")).toBeTruthy();
    fireEvent.click(getByLabelText("Automatic compaction level"));
    fireEvent.click(getByRole("option", { name: "Maximum (872k)" }));
    await waitFor(() =>
      expect(mock.calls.setContextCompactionConfig).toEqual([{ level: "max" }]),
    );
  });
});
