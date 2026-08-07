import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LocaleProvider, makeT } from "../../i18n/LocaleProvider.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { ActivityStep } from "./ActivityStep.js";

const tEn = makeT("en");

describe("ActivityStep", () => {
  it("renders the body text and a verb icon", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="Reading scripts" t={tEn} active={false} />,
    );
    expect(screen.getByText("Reading scripts")).toBeInTheDocument();
    expect(container.querySelector('svg[data-icon="read"]')).not.toBeNull();
  });

  it("adds is-active only when active", () => {
    const { container, rerender } = renderWithLocale(
      <ActivityStep body="Writing a.ts" t={tEn} active={false} />,
    );
    expect(container.querySelector(".activity-step.is-active")).toBeNull();
    rerender(
      <LocaleProvider locale="en" onLocaleChange={() => {}}>
        <ActivityStep body="Writing a.ts" t={tEn} active={true} />
      </LocaleProvider>,
    );
    expect(container.querySelector(".activity-step.is-active")).not.toBeNull();
  });

  it("strips the literal ↳ on a continuation row (the result icon conveys it; no doubled arrow)", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ write_new_file failed: file_exists: scripts/sort.py already exists"
        t={tEn}
        active={false}
      />,
    );
    // The result arrow icon stands in for the continuation marker.
    expect(container.querySelector('svg[data-icon="result"]')).not.toBeNull();
    expect(
      container.querySelector(".activity-step.is-continuation"),
    ).not.toBeNull();
    // The rendered text no longer carries the literal ↳ (no "↳ ↳").
    const body = container.querySelector(".activity-step__body");
    expect(body?.textContent).toBe(
      "write_new_file failed: file_exists: scripts/sort.py already exists",
    );
    expect(body?.textContent?.includes("↳")).toBe(false);
  });

  it("leaves a non-continuation body untouched", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="Reading scripts/sort.py" t={tEn} active={false} />,
    );
    expect(container.querySelector(".activity-step__body")?.textContent).toBe(
      "Reading scripts/sort.py",
    );
  });

  it("marks failure rows with is-failure and the ✗ icon (2026-07-23)", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ read_file failed: tool_crashed: boom"
        t={tEn}
        icon="fail"
        active={false}
        failed
      />,
    );
    expect(container.querySelector(".activity-step.is-failure")).not.toBeNull();
    expect(container.querySelector('svg[data-icon="fail"]')).not.toBeNull();
    // fail is a continuation icon — the literal arrow is stripped.
    expect(
      container
        .querySelector(".activity-step__body")
        ?.textContent?.includes("↳"),
    ).toBe(false);
  });

  it("renders evidenceDetail behind a collapsed toggle (2026-07-23)", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ exit 0 · 3 lines"
        t={tEn}
        active={false}
        detail={"↳ 输出:\nhello world"}
      />,
    );
    // Collapsed by default: toggle present, detail absent.
    const toggle = container.querySelector(".activity-step__detail-toggle");
    expect(toggle).not.toBeNull();
    expect(container.querySelector(".activity-step__detail")).toBeNull();
    fireEvent.click(toggle as HTMLButtonElement);
    expect(
      container.querySelector(".activity-step__detail")?.textContent,
    ).toContain("hello world");
  });

  it("shows no detail toggle without evidenceDetail", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="Reading a.ts" t={tEn} active={false} />,
    );
    expect(container.querySelector(".activity-step__detail-toggle")).toBeNull();
  });
});
