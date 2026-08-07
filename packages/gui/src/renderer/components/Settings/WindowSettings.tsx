import { useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { ThemePref } from "../../ipc/bridge-types.js";
import { applyThemePref, themePref } from "../../lib/theme.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

/**
 * Settings → Window: appearance (night-mode slice 2) + the close-to-tray
 * toggle (user request 2026-07-06 — the always-on tray behavior becomes a
 * choice). LIVE apply on both: the theme stamps <html data-theme> before
 * the persist settles; main updates its close handler the moment the write
 * lands. Mirrors DreamSettings' optimistic-flip/snap-back shape.
 */
export function WindowSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  // Default ON until the persisted value loads (tray is the default).
  const [enabled, setEnabled] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Seed from the controller (already booted by App) — no async flash.
  const [theme, setTheme] = useState<ThemePref>(() => themePref());

  const onTheme = (next: ThemePref): void => {
    // Apply LIVE first (the whole point), then persist. A failed write
    // keeps the live theme but flags the save error — snapping the theme
    // back would flash the UI over a disk hiccup.
    setTheme(next);
    applyThemePref(next);
    setFailed(false);
    void bridge.setTheme?.(next).catch(() => setFailed(true));
  };

  useEffect(() => {
    let alive = true;
    bridge.getCloseToTray().then(
      (v) => {
        if (alive) setEnabled(v);
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
    // Optimistic: flip now, persist async. On a failed write, snap back so
    // the toggle never claims a state that didn't reach disk.
    setEnabled(next);
    setFailed(false);
    void bridge.setCloseToTray(next).catch(() => {
      setEnabled(!next);
      setFailed(true);
    });
  };

  return (
    <>
      <p className="settings-intro">{t("window.intro")}</p>
      <SettingRow
        title={t("window.theme")}
        description={t("window.themeDesc")}
        control={
          <Select
            value={theme}
            ariaLabel={t("window.theme")}
            options={[
              { value: "light", label: t("theme.light") },
              { value: "dark", label: t("theme.dark") },
              { value: "system", label: t("theme.system") },
            ]}
            onChange={onTheme}
          />
        }
      />
      <SettingRow
        title={t("window.closeToTray")}
        description={t("window.closeToTrayDesc")}
        control={
          <Toggle
            checked={enabled}
            ariaLabel={t("window.closeToTray")}
            onChange={onChange}
          />
        }
      />
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
