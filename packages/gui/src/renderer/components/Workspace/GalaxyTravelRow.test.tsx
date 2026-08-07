import { describe, expect, it } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { GalaxyTravelRow } from "./GalaxyTravelRow.js";

describe("GalaxyTravelRow", () => {
  it("shimmers the transfer text (no traveling packet)", () => {
    const { container } = renderWithLocale(<GalaxyTravelRow />);
    expect(container.querySelector(".galaxy-packet")).toBeNull();
    expect(
      container
        .querySelector(".transfer-text")
        ?.classList.contains("is-shimmer"),
    ).toBe(true);
  });

  it("mounts a day AND a night variant of both icons (CSS display swap on data-theme)", () => {
    // The night set is the user-drawn white icons for the dark shell
    // (2026-07-13); both variants stay mounted so a theme flip swaps with
    // no decode flash.
    const { container } = renderWithLocale(<GalaxyTravelRow />);
    expect(container.querySelectorAll(".transfer-icon--day")).toHaveLength(2);
    expect(container.querySelectorAll(".transfer-icon--night")).toHaveLength(2);
  });
});
