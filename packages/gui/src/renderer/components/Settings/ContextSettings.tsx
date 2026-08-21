import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { CompactionLevelChoice } from "../../ipc/bridge-types.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";

/** Five automatic-compaction strategies for the 1M-token actor context. */
export function ContextSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const supported =
    bridge.getContextCompactionConfig !== undefined &&
    bridge.setContextCompactionConfig !== undefined;
  const [level, setLevel] = useState<CompactionLevelChoice>("standard");
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    void bridge.getContextCompactionConfig?.().then(
      (config) => {
        if (alive) setLevel(config.level);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, supported]);

  const choose = (next: CompactionLevelChoice): void => {
    if (bridge.setContextCompactionConfig === undefined) return;
    const previous = level;
    const seq = ++requestSeq.current;
    setLevel(next);
    setSaveFailed(false);
    void bridge.setContextCompactionConfig({ level: next }).catch(() => {
      if (seq !== requestSeq.current) return;
      setLevel(previous);
      setSaveFailed(true);
    });
  };

  if (!supported) {
    return (
      <>
        <p className="settings-intro">{t("compaction.intro")}</p>
        <p className="settings-note">{t("compaction.unavailable")}</p>
      </>
    );
  }

  return (
    <>
      <p className="settings-intro">{t("compaction.intro")}</p>
      <SettingRow
        title={t("compaction.level")}
        description={t("compaction.levelDesc")}
        control={
          <Select<CompactionLevelChoice>
            value={level}
            ariaLabel={t("compaction.level")}
            options={[
              { value: "minimal", label: t("compaction.minimal") },
              { value: "low", label: t("compaction.low") },
              { value: "standard", label: t("compaction.standard") },
              { value: "balanced", label: t("compaction.balanced") },
              { value: "max", label: t("compaction.max") },
            ]}
            onChange={choose}
          />
        }
      />
      {!saveFailed && !loadFailed && (
        <p className="settings-note">{t("compaction.applyNote")}</p>
      )}
      {saveFailed && <p className="settings-note">{t("common.couldntSave")}</p>}
      {!saveFailed && loadFailed && (
        <p className="settings-note">{t("settings.loadFailed")}</p>
      )}
    </>
  );
}
