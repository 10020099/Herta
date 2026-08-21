import type { ContextUsage } from "@herta/app-server";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";

interface ContextIndicatorProps {
  readonly sessionId: string | null;
  readonly busy: boolean;
  readonly onQueued: (notice: string) => void;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/**
 * The ring tracks progress toward the current automatic compaction threshold,
 * while the popover always states the estimated token count explicitly. This
 * keeps the quiet affordance useful at a glance without obscuring the real
 * amount of context currently in Herta's prompt.
 */
export function ContextIndicator(props: ContextIndicatorProps): JSX.Element {
  const { bridge } = useHertaBridge();
  const t = useT();
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);

  const refresh = useCallback((): void => {
    const id = props.sessionId;
    if (id === null || bridge.getContextUsage === undefined) {
      setUsage(null);
      return;
    }
    setUsage(null);
    void bridge
      .getContextUsage(id)
      .then((next) => setUsage(next))
      .catch(() => setUsage(null));
  }, [bridge, props.sessionId]);

  useEffect(() => {
    // Refresh on activation and after a turn becomes idle: the record and any
    // new recap have settled, so this is the prompt that will be sent next.
    if (!props.busy) refresh();
  }, [props.busy, refresh]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const position = (): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    setAt({
      left: Math.round(rect.left + rect.width / 2),
      bottom: Math.round(window.innerHeight - rect.top + 8),
    });
  };

  const keepOpen = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    position();
    setOpen(true);
  };

  const deferClose = (): void => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 140);
  };

  const requestCompaction = (): void => {
    const id = props.sessionId;
    if (
      id === null ||
      props.busy ||
      usage?.compactionPending === true ||
      bridge.requestContextCompaction === undefined
    ) {
      return;
    }
    void bridge
      .requestContextCompaction(id)
      .then((result) => {
        if (!result.ok) {
          props.onQueued(
            result.reason === "turn_in_progress"
              ? t("composer.attach.busy")
              : t("composer.context.unavailable"),
          );
          return;
        }
        setUsage((current) =>
          current === null ? current : { ...current, compactionPending: true },
        );
        props.onQueued(t("composer.context.queued"));
      })
      .catch(() => props.onQueued(t("composer.context.unavailable")));
  };

  const threshold = usage?.compactThresholdTokens ?? 0;
  const used = usage?.usedTokens ?? 0;
  const progress =
    threshold > 0 ? Math.max(0, Math.min(used / threshold, 1)) : 0;
  const circumference = 2 * Math.PI * 7;
  const dashOffset = circumference * (1 - progress);
  const unavailable = usage === null || threshold <= 0;

  return (
    <span className="composer-context-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`composer-context${open ? " is-open" : ""}${
          unavailable ? " is-unavailable" : ""
        }${progress >= 1 ? " is-near-compact" : ""}`}
        aria-label={t("composer.context.aria")}
        aria-expanded={open}
        onPointerEnter={keepOpen}
        onPointerLeave={deferClose}
        onFocus={keepOpen}
        onBlur={deferClose}
        onClick={() => {
          if (open) setOpen(false);
          else keepOpen();
        }}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle className="composer-context__track" cx="10" cy="10" r="7" />
          <circle
            className="composer-context__value"
            cx="10"
            cy="10"
            r="7"
            style={{
              strokeDasharray: circumference,
              strokeDashoffset: dashOffset,
            }}
          />
        </svg>
      </button>
      {open &&
        at !== null &&
        createPortal(
          <div
            className="composer-context-popover"
            role="dialog"
            aria-label={t("composer.context.aria")}
            style={{ left: `${at.left}px`, bottom: `${at.bottom}px` }}
            onPointerEnter={keepOpen}
            onPointerLeave={deferClose}
          >
            {unavailable ? (
              <p className="composer-context-popover__muted">
                {t("composer.context.unavailable")}
              </p>
            ) : (
              <>
                <strong>
                  {t("composer.context.used", { tokens: formatTokens(used) })}
                </strong>
                <span>
                  {t("composer.context.threshold", {
                    tokens: formatTokens(threshold),
                  })}
                </span>
                {usage.recapCharacters > 0 && (
                  <span>
                    {t("composer.context.recap", {
                      chars: usage.recapCharacters,
                    })}
                  </span>
                )}
                <button
                  type="button"
                  className="composer-context-popover__action"
                  disabled={props.busy || usage.compactionPending}
                  onClick={requestCompaction}
                >
                  {usage.compactionPending
                    ? t("composer.context.pending")
                    : t("composer.context.compress")}
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
