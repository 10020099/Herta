import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import type {
  InteractionLanguageChoice,
  Locale,
} from "../../ipc/bridge-types.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";

/** Settings → Language. The UI-language row applies live (no restart). The
 *  control is the app's own Select (2026-07-12) — the native `<select>` popup
 *  was OS chrome that ignored the design language entirely.
 *
 *  The INTERACTION-language row (slice 4) is a separate per-user setting: the
 *  language Herta is prompted in. "Follow UI language" is the default (no
 *  stored choice); it applies to NEW sessions only, and EN sessions have no
 *  opening voice in this release — the description says both. */
export function LanguageSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const { locale, setLocale } = useLocale();
  // The interaction-language bridge surface is OPTIONAL (fakes / the website
  // demo omit it); the row hides with it, mirroring UpdateSettings.tsx's
  // `autoSupported`.
  const interactionSupported = bridge.setInteractionLanguage !== undefined;
  // Default "follow" until the persisted choice loads (follow is the default).
  const [interaction, setInteraction] =
    useState<InteractionLanguageChoice>("follow");
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Once the user picks, the in-flight async load must not clobber the pick.
  const touchedRef = useRef(false);
  // Latest-wins guard: two overlapping failed writes must not snap back to a
  // stale value — only the newest write may revert.
  const writeSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    bridge.getInteractionLanguage?.().then(
      (v) => {
        if (alive && !touchedRef.current) setInteraction(v);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const onInteraction = (next: InteractionLanguageChoice): void => {
    // Optimistic: show the choice now, persist async. On a failed write, snap
    // back so the row never claims a state that didn't reach disk.
    const prev = interaction;
    writeSeqRef.current += 1;
    const seq = writeSeqRef.current;
    touchedRef.current = true;
    setInteraction(next);
    setFailed(false);
    void bridge.setInteractionLanguage?.(next).catch(() => {
      // Snap-back AND the error note, both only when no newer pick has
      // superseded this write (audit BL14) — the note used to fire
      // unconditionally, painting "couldn't save" over a newer choice that
      // had actually saved.
      if (seq !== writeSeqRef.current) return;
      setInteraction(prev);
      setFailed(true);
    });
  };

  return (
    <>
      <SettingRow
        title={t("language.rowLabel")}
        description={t("language.intro")}
        control={
          <Select<Locale>
            value={locale}
            ariaLabel={t("language.rowLabel")}
            options={[
              { value: "zh", label: "中文" },
              { value: "en", label: "English" },
            ]}
            onChange={(next) => setLocale(next)}
          />
        }
      />
      {interactionSupported && (
        <SettingRow
          title={t("language.interactionRowLabel")}
          description={t("language.interactionDesc")}
          control={
            <Select<InteractionLanguageChoice>
              value={interaction}
              ariaLabel={t("language.interactionRowLabel")}
              options={[
                { value: "follow", label: t("language.follow") },
                { value: "zh", label: "中文" },
                { value: "en", label: "English" },
              ]}
              onChange={onInteraction}
            />
          }
        />
      )}
      {failed ? (
        <p className="settings-note">{t("common.couldntSave")}</p>
      ) : (
        loadFailed && (
          <p className="settings-note">{t("settings.loadFailed")}</p>
        )
      )}
    </>
  );
}
