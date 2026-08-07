import { Fragment, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";

/** Only the device card remains — the voice card was retired when the tide
 *  wave moved above the composer (glass-wave merge, 2026-07-05). */
export type CardKind = "device";

/** Render a filesystem path with a `<wbr>` break opportunity after each
 *  separator, so a long path wraps at folder boundaries instead of
 *  char-by-char. The full path is still one string in `textContent`. */
function breakablePath(path: string): JSX.Element[] {
  const parts = path.split(/(?<=[\\/])/).filter((p) => p.length > 0);
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional segments of a stable path string
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

/** Leave-animation duration; keep in sync with the `cardMenuOut` keyframe in
 *  reference-ux.css. The menu stays mounted this long after closing so the exit
 *  animation can play, then unmounts. */
const MENU_EXIT_MS = 120;

export interface CardMenuProps {
  readonly cardKind: CardKind;
  readonly activeWorkspace?: string;
  readonly isDefault?: boolean;
  readonly onSetWorkspace?: () => void;
  readonly onResetWorkspace?: () => void;
  readonly errorText?: string;
  /** Project command allow rules (ADR 0030) as display strings. PRESENTATIONAL,
   *  like everything else here: DeviceCard owns the bridge and passes these
   *  down. `undefined` → the section is not rendered at all (the bridge lacks
   *  the surface, or the parent doesn't manage rules) — that keeps this
   *  component renderable with no HertaBridgeProvider, which its own test file
   *  relies on and which a first cut broke (CI 2026-08-04). */
  readonly rules?: readonly string[];
  readonly onRemoveRule?: (display: string) => void;
  /** Fired when the menu OPENS — DeviceCard re-fetches rules on it, so a rule
   *  granted mid-commission shows up without a remount. */
  readonly onOpen?: () => void;
}

export function CardMenu(props: CardMenuProps): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Project command allow rules (ADR 0030) live in THIS menu rather than
  // Settings (owner 2026-08-04): they're session-workspace-scoped, and the
  // workspace they bind to is displayed right above them. The DATA, though,
  // belongs to DeviceCard — see CardMenuProps.rules.
  const rules = props.rules;
  // Tell the parent to refresh on open. Deliberately keyed on `open` alone:
  // onOpen is called for the open EDGE, and a parent that re-creates the
  // callback each render must not re-trigger a fetch.
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);
  // Only the topmost overlay owns Escape (overlay-stack.ts): closing this
  // menu must consume the keypress, not ALSO close a settings modal below it
  // or deny a pending approval.
  const isTop = useModalOverlay("card-menu", open, OVERLAY_Z.cardMenu);
  // Dismiss on an outside click or Escape — previously the menu only closed
  // by toggling the ⋯ button, so it lingered when the user clicked elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (
        rootRef.current !== null &&
        !rootRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTop) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, isTop]);
  // Mount/exit animation: enter is a CSS keyframe that plays on mount; on close
  // we keep the node mounted (with `is-leaving`) until the exit animation ends,
  // then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const t = window.setTimeout(() => setMounted(false), MENU_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  // The device card becomes an actionable workspace menu only when the
  // workspace handlers are wired (DeviceCard always passes them). Without
  // them it stays a static info tooltip.
  const isWorkspaceMenu =
    props.cardKind === "device" && props.onSetWorkspace !== undefined;
  return (
    <div className="card-menu" ref={rootRef}>
      <button
        type="button"
        className="card-menu-button"
        aria-label={t("card.deviceInfoAria")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {mounted &&
        (isWorkspaceMenu ? (
          <div
            className={`card-menu-tooltip${open ? "" : " is-leaving"}`}
            role="menu"
          >
            <div className="card-menu-current">
              <span className="card-menu-label">
                {props.isDefault
                  ? t("card.workspaceDefault")
                  : t("card.workspace")}
              </span>
              <span
                className="card-menu-path"
                title={props.activeWorkspace ?? undefined}
              >
                {props.activeWorkspace !== undefined
                  ? breakablePath(props.activeWorkspace)
                  : "—"}
              </span>
            </div>
            <div className="card-menu-divider" />
            <button
              type="button"
              className="card-menu-item"
              onClick={() => {
                // Close first: "Set workspace…" opens the OS folder dialog,
                // and a menu left hanging under it read as stuck (and invited
                // a second click queueing a second dialog).
                setOpen(false);
                props.onSetWorkspace?.();
              }}
            >
              {t("card.setWorkspace")}
            </button>
            <button
              type="button"
              className="card-menu-item"
              disabled={props.isDefault === true}
              onClick={() => {
                setOpen(false);
                props.onResetWorkspace?.();
              }}
            >
              {t("card.resetDefault")}
            </button>
            {rules !== undefined && (
              <>
                <div className="card-menu-divider" />
                <div className="card-menu-rules">
                  <span className="card-menu-label">{t("card.rules")}</span>
                  {rules.length === 0 ? (
                    <span className="card-menu-rules-empty">
                      {t("card.rulesEmpty")}
                    </span>
                  ) : (
                    <ul className="card-menu-rules-list">
                      {rules.map((r) => (
                        <li className="card-menu-rule" key={r}>
                          <code className="card-menu-rule-text" title={r}>
                            {r}
                          </code>
                          <button
                            type="button"
                            className="card-menu-rule-remove"
                            aria-label={t("card.rulesRemove", { rule: r })}
                            onClick={() => props.onRemoveRule?.(r)}
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
            {props.errorText !== undefined && (
              <div className="card-menu-error" role="alert">
                {props.errorText}
              </div>
            )}
          </div>
        ) : (
          <div
            className={`card-menu-tooltip${open ? "" : " is-leaving"}`}
            role="tooltip"
          >
            {t("card.deviceInfo")}
          </div>
        ))}
    </div>
  );
}
