import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip.js";

describe("Tooltip", () => {
  it("renders the trigger and a role=tooltip label", () => {
    render(
      <Tooltip label="Hello">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Trigger" })).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Hello");
  });

  it("defaults to bottom placement", () => {
    const { container } = render(
      <Tooltip label="X">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-bottom"),
    ).toBe(true);
  });

  it("applies top placement when requested", () => {
    const { container } = render(
      <Tooltip label="X" placement="top">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-top"),
    ).toBe(true);
  });

  it("defaults to align=center, emitting tooltip-align-center", () => {
    const { container } = render(
      <Tooltip label="X">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-align-center"),
    ).toBe(true);
  });

  it("emits tooltip-align-end when align=end", () => {
    const { container } = render(
      <Tooltip label="X" align="end">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-align-end"),
    ).toBe(true);
  });

  it("emits tooltip-align-start when align=start", () => {
    const { container } = render(
      <Tooltip label="X" align="start">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(
      container
        .querySelector(".tooltip-wrap")
        ?.classList.contains("tooltip-align-start"),
    ).toBe(true);
  });

  it("renders a muted second line when sub is given, none otherwise", () => {
    const { container, rerender } = render(
      <Tooltip label="Add documents" sub="Text files">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(container.querySelector(".tooltip-sub")?.textContent).toBe(
      "Text files",
    );
    rerender(
      <Tooltip label="Add documents">
        <button type="button">T</button>
      </Tooltip>,
    );
    expect(container.querySelector(".tooltip-sub")).toBeNull();
  });

  it("suppresses the tooltip on pointerdown and re-arms it on pointerleave", () => {
    const { container } = render(
      <Tooltip label="X">
        <button type="button">T</button>
      </Tooltip>,
    );
    const wrap = container.querySelector(".tooltip-wrap") as HTMLElement;
    expect(wrap.classList.contains("is-suppressed")).toBe(false);
    // Click (pointerdown) hides it while still hovering…
    fireEvent.pointerDown(wrap);
    expect(wrap.classList.contains("is-suppressed")).toBe(true);
    // …and leaving the control re-arms it for the next hover.
    fireEvent.pointerLeave(wrap);
    expect(wrap.classList.contains("is-suppressed")).toBe(false);
  });
});
