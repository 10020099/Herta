import { useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

/**
 * The Dream settings section — a single "Enable Dream" toggle. Reads the
 * persisted flag via IPC on mount; a change writes it and applies on the next
 * app restart (restart-to-apply), so a "Restart to apply." note appears once the
 * user has changed it. See SPEC 2026-06-23 dream-settings.
 */
export function DreamSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  // Default to ON until the persisted value loads (Dream is on by default).
  const [enabled, setEnabled] = useState(true);
  // The value when the section opened — what the running app is using. The
  // restart note shows only when the toggle now DIFFERS from it, so toggling
  // back to the original hides it again.
  const [initial, setInitial] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  // A rejected config read previously died silently: the toggle showed the
  // optimistic default with `initial` never set, so the restart note could
  // never appear and the user had no idea the pane wasn't showing disk state.
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    bridge.getDreamConfig().then(
      (c) => {
        if (alive) {
          setEnabled(c.enabled);
          setInitial(c.enabled);
        }
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const onChange = (next: boolean): void => {
    // Optimistic: flip now, persist async. If the write fails, snap back so the
    // toggle never claims a state that didn't reach disk.
    setEnabled(next);
    setFailed(false);
    void bridge.setDreamConfig({ enabled: next }).catch(() => {
      setEnabled(!next);
      setFailed(true);
    });
  };

  const changed = initial !== null && enabled !== initial;

  return (
    <>
      <p className="settings-intro">{t("dream.intro")}</p>
      <SettingRow
        title={t("dream.enable")}
        description={t("dream.enableDesc")}
        control={
          <Toggle
            checked={enabled}
            ariaLabel={t("dream.enable")}
            onChange={onChange}
          />
        }
      />
      {failed ? (
        <p className="settings-note">{t("common.couldntSave")}</p>
      ) : loadFailed ? (
        <p className="settings-note">{t("settings.loadFailed")}</p>
      ) : (
        changed && <p className="settings-note">{t("common.restartToApply")}</p>
      )}
    </>
  );
}
