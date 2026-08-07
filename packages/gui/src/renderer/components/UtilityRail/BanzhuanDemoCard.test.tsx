import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BanzhuanDemoCard } from "./BanzhuanDemoCard.js";

describe("BanzhuanDemoCard", () => {
  it("renders the device-card markup for the given state", () => {
    const { container } = render(<BanzhuanDemoCard state="delegated" />);
    const card = container.querySelector(".device-card");
    expect(card?.getAttribute("data-state")).toBe("delegated");
    expect(container.querySelector(".agent-ring.is-delegated")).toBeTruthy();
    expect(container.querySelector(".agent-spill.is-delegated")).toBeTruthy();
  });

  it("is non-interactive (renders no button)", () => {
    const { container } = render(<BanzhuanDemoCard state="idle" />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("reports hover changes for pause-on-hover", () => {
    const onHoverChange = vi.fn();
    const { container } = render(
      <BanzhuanDemoCard state="idle" onHoverChange={onHoverChange} />,
    );
    const card = container.querySelector(".device-card") as HTMLElement;
    fireEvent.mouseEnter(card);
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(card);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });
});
