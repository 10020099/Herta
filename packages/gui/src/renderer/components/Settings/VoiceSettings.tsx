import type { CSSProperties } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { useVoiceMuted } from "../../voice/useVoiceMuted.js";
import { useVoiceVolume } from "../../voice/useVoiceVolume.js";
import { setVoiceMuted, setVoiceVolume } from "../../voice/voice-prefs.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

/** The Voice settings section — master mute + master volume. */
export function VoiceSettings(): JSX.Element {
  const t = useT();
  const muted = useVoiceMuted();
  const volume = useVoiceVolume();
  return (
    <>
      <SettingRow
        title={t("voice.mute")}
        description={t("voice.muteDesc")}
        control={
          <Toggle
            checked={muted}
            ariaLabel={t("voice.mute")}
            onChange={(next) => {
              setVoiceMuted(next);
              // Turning mute ON cuts any clip already playing (immediate silence).
              if (next) stopAllVoice();
            }}
          />
        }
      />
      <SettingRow
        title={t("voice.volume")}
        description={t("voice.volumeDesc")}
        control={
          <span
            className={`settings-slider-wrap${muted ? " is-disabled" : ""}`}
          >
            <input
              type="range"
              className="settings-slider"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              /* The custom track paints its LED fill from this var — CSS
                 alone can't know a range input's value. */
              style={
                {
                  "--slider-fill": `${Math.round(volume * 100)}%`,
                } as CSSProperties
              }
              aria-label={t("voice.volume")}
              disabled={muted}
              onChange={(e) => {
                setVoiceVolume(Number(e.target.value) / 100);
                // Re-scale a clip that is ALREADY playing, so dragging the
                // slider mid-line is audible immediately.
                applyVoiceVolume();
              }}
            />
            <span className="settings-slider-value">
              {Math.round(volume * 100)}%
            </span>
          </span>
        }
      />
    </>
  );
}
