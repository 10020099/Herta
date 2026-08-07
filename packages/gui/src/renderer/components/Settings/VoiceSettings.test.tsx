import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { applyVoiceVolume } from "../../voice/play-voice.js";
import { setVoiceVolume } from "../../voice/voice-prefs.js";
import { VoiceSettings } from "./VoiceSettings.js";

// Silence the voice modules — not under test here. Mutable holders let the
// per-test state flip what the (hoisted) module mocks report.
const mutedState = { value: false };
const volumeState = { value: 0.8 };
vi.mock("../../voice/play-voice.js", () => ({
  stopAllVoice: vi.fn(),
  applyVoiceVolume: vi.fn(),
}));
vi.mock("../../voice/useVoiceMuted.js", () => ({
  useVoiceMuted: () => mutedState.value,
}));
vi.mock("../../voice/useVoiceVolume.js", () => ({
  useVoiceVolume: () => volumeState.value,
}));
vi.mock("../../voice/voice-prefs.js", () => ({
  setVoiceMuted: vi.fn(),
  setVoiceVolume: vi.fn(),
}));

afterEach(() => {
  mutedState.value = false;
  volumeState.value = 0.8;
  vi.clearAllMocks();
});

describe("VoiceSettings", () => {
  it("renders the mute toggle with localized label", () => {
    const { getByLabelText, getByText } = renderWithLocale(<VoiceSettings />);
    expect(getByLabelText("Mute voice")).toBeTruthy();
    expect(getByText("Mute voice")).toBeTruthy();
    expect(getByText("Silence all of Herta's voice.")).toBeTruthy();
  });

  it("renders the volume slider with the current percentage", () => {
    const { getByLabelText, getByText } = renderWithLocale(<VoiceSettings />);
    const slider = getByLabelText("Volume") as HTMLInputElement;
    expect(slider.value).toBe("80");
    expect(slider.disabled).toBe(false);
    expect(getByText("80%")).toBeTruthy();
  });

  it("dragging the slider persists the volume AND re-scales the playing clip", () => {
    const { getByLabelText } = renderWithLocale(<VoiceSettings />);
    fireEvent.change(getByLabelText("Volume"), { target: { value: "60" } });
    expect(vi.mocked(setVoiceVolume)).toHaveBeenCalledWith(0.6);
    expect(vi.mocked(applyVoiceVolume)).toHaveBeenCalled();
  });

  it("the slider is disabled (and its wrap dimmed) while muted", () => {
    mutedState.value = true;
    const { getByLabelText, container } = renderWithLocale(<VoiceSettings />);
    const slider = getByLabelText("Volume") as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(
      container.querySelector(".settings-slider-wrap.is-disabled"),
    ).not.toBeNull();
  });
});
