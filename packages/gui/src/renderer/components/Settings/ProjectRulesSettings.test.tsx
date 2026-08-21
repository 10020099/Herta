import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { ProjectRulesSettings } from "./ProjectRulesSettings.js";

describe("ProjectRulesSettings", () => {
  it("loads, edits, saves, adds, and deletes only managed project rules", async () => {
    const mock = createMockHertaBridge({
      projectRules: [
        { name: "rules.md", content: "# First rule\nBe concise." },
        { name: "rules2.md", content: "# Third rule" },
      ],
    });
    const { getByLabelText, getByRole } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <ProjectRulesSettings />
      </HertaBridgeProvider>,
    );

    await waitFor(() => expect(mock.calls.listProjectRules).toBe(1));
    fireEvent.change(getByLabelText("Markdown rule content"), {
      target: { value: "# First rule\nInspect before editing." },
    });
    fireEvent.click(getByRole("button", { name: "Save rule" }));
    await waitFor(() =>
      expect(mock.calls.saveProjectRule).toEqual([
        ["rules.md", "# First rule\nInspect before editing."],
      ]),
    );

    fireEvent.click(getByRole("button", { name: "Add rule" }));
    expect(getByRole("button", { name: "rules1.md" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mock.calls.deleteProjectRule).toEqual(["rules1.md"]),
    );
  });
});
