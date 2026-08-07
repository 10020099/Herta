import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useDemoDeviceCycle } from "../../hooks/useDemoDeviceCycle.js";
import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import type { BackendThinking } from "../../ipc/bridge-types.js";
import { BanzhuanDemoCard } from "../UtilityRail/BanzhuanDemoCard.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";

type DemoState =
  | "idle"
  | "delegated"
  | "waitingApproval"
  | "succeeded"
  | "failed";

interface StateMeta {
  readonly stateKey: MessageKey;
  readonly legendKey: MessageKey;
  /** Legend swatch color — approximates the state's glow. Decorative. */
  readonly dot: string;
}

const STATE_META: Record<DemoState, StateMeta> = {
  idle: {
    stateKey: "device.state.idle",
    legendKey: "banzhuan.legend.idle",
    dot: "#7ba3f0",
  },
  delegated: {
    stateKey: "device.state.working",
    legendKey: "banzhuan.legend.delegated",
    dot: "#4d86ff",
  },
  waitingApproval: {
    stateKey: "device.state.awaitingApproval",
    legendKey: "banzhuan.legend.waitingApproval",
    dot: "#f0b34a",
  },
  succeeded: {
    stateKey: "device.state.done",
    legendKey: "banzhuan.legend.succeeded",
    dot: "#5fd093",
  },
  failed: {
    stateKey: "device.state.error",
    legendKey: "banzhuan.legend.failed",
    dot: "#f2655f",
  },
};

const LEGEND_ORDER: readonly DemoState[] = [
  "idle",
  "delegated",
  "waitingApproval",
  "succeeded",
  "failed",
];

/** Look up a state's display meta, falling back to idle (the cycle only emits
 *  the five demo states, but `state` is the wider device-state union). */
function metaFor(state: BanzhuanDeviceState): StateMeta {
  return STATE_META[state as DemoState] ?? STATE_META.idle;
}

/**
 * The 差分协处理器 settings section: a short explainer of the silent coding
 * backend, the backend thinking-effort Select (low/high/max,
 * restart-to-apply), then a read-only device card that auto-cycles through
 * its lifecycle (pause on hover) with a synced caption, plus a static
 * 5-state legend. The visual reuses the live rail card; only the meaning
 * text lives here. The ADR 0030 command-rule list deliberately does NOT
 * live in this pane: rules are session-workspace-scoped, so they're managed
 * in the device card's ⋯ menu next to the workspace they bind to (owner
 * 2026-08-04 — a first cut here was moved out same day).
 *
 * Layout rules (owner feedback 2026-08-03, "re-design — it changed the
 * panel height"): the pane must stay inside `.settings-content`'s stable
 * min-height floor so switching sections never resizes the card, and the
 * effort Select sits ABOVE the demo card — its popover menu is an in-flow
 * absolute box (no portal), so near the pane's bottom edge it clipped
 * against the card; up here it opens downward into the demo's space.
 * There is deliberately NO dynamic restart note: the row description
 * already says "下次启动生效", and an appearing note re-flowed the pane.
 *
 * NOTE on "low": DeepSeek's 2026-07-31 update gave deepseek-v4-flash the low
 * tier; deepseek-v4-pro (the backend default) maps a sent "low" to "high"
 * server-side until its announced early-August-2026 update. Owner decision
 * 2026-08-03: persist and send the choice as-is — it starts meaning low the
 * day DeepSeek ships that, with no change here. The UI deliberately does not
 * mention the transient mapping.
 */
export function BanzhuanSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const { locale } = useLocale();
  const [paused, setPaused] = useState(false);
  const state = useDemoDeviceCycle(paused);
  const meta = metaFor(state);

  // Thinking-effort row. The bridge surface is OPTIONAL (fakes / the website
  // demo omit it); the row hides with it, mirroring LanguageSettings' handling
  // of the interaction-language pair.
  const thinkingSupported = bridge.setBackendConfig !== undefined;
  // Default "high" until the persisted value loads (the real handler's
  // default).
  const [thinking, setThinking] = useState<BackendThinking>("high");
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Once the user picks, the in-flight async load must not clobber the pick.
  const touchedRef = useRef(false);
  // Latest-wins guard: two overlapping failed writes must not snap back to a
  // stale value — only the newest write may revert.
  const writeSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    bridge.getBackendConfig?.().then(
      (c) => {
        if (alive && !touchedRef.current) setThinking(c.thinking);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const onThinking = (next: BackendThinking): void => {
    // Optimistic: show the pick now, persist async. On a failed write, snap
    // back so the row never claims a state that didn't reach disk.
    const prev = thinking;
    writeSeqRef.current += 1;
    const seq = writeSeqRef.current;
    touchedRef.current = true;
    setThinking(next);
    setFailed(false);
    void bridge.setBackendConfig?.({ thinking: next }).catch(() => {
      // Both inside the latest-wins guard (audit BL14). The snap-back was
      // guarded and the error note was not, so a stale write's failure
      // painted an error over a NEWER pick that had succeeded — the row read
      // "couldn't save" while showing a value that was on disk.
      if (seq !== writeSeqRef.current) return;
      setThinking(prev);
      setFailed(true);
    });
  };

  // Split the intro around the literal @板砖 token to preserve <code> styling.
  // This is Settings CHROME — the surrounding prose is `t()` (UI locale), so the
  // trigger label follows the UI locale too, not the active session's language:
  // an all-English panel must not show a lone CJK @板砖 (and this pane can be
  // open with no active session). @Brick / @板砖 are display-only; the wire token
  // is unchanged, and @brick is accepted case-insensitively in EN sessions.
  const introParts = t("banzhuan.intro").split("@板砖");
  const trigger = locale === "en" ? "@Brick" : "@板砖";

  return (
    <>
      <p className="settings-intro">
        {introParts[0]}
        <code>{trigger}</code>
        {introParts[1] ?? ""}
      </p>

      {thinkingSupported && (
        <SettingRow
          title={t("banzhuan.thinking")}
          description={t("banzhuan.thinkingDesc")}
          control={
            <Select<BackendThinking>
              value={thinking}
              ariaLabel={t("banzhuan.thinking")}
              options={[
                { value: "low", label: t("banzhuan.thinking.low") },
                { value: "high", label: t("banzhuan.thinking.high") },
                { value: "max", label: t("banzhuan.thinking.max") },
              ]}
              onChange={onThinking}
            />
          }
        />
      )}
      {thinkingSupported && failed && (
        <p className="settings-note">{t("common.couldntSave")}</p>
      )}
      {thinkingSupported && !failed && loadFailed && (
        <p className="settings-note">{t("settings.loadFailed")}</p>
      )}

      <div className="settings-bz-demo">
        <BanzhuanDemoCard state={state} onHoverChange={setPaused} />
        <div className="settings-bz-caption">
          <span className="settings-bz-caption-name">{t(meta.stateKey)}</span>
          <span className="settings-bz-caption-meaning">
            {t(meta.legendKey)}
          </span>
        </div>
      </div>

      <div className="settings-bz-legend">
        {LEGEND_ORDER.map((key) => {
          const m = metaFor(key);
          return (
            <div className="settings-bz-legend-item" key={key}>
              <span
                className="settings-bz-dot"
                style={{ background: m.dot }}
                aria-hidden="true"
              />
              <span>{t(m.stateKey)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
