import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionLang } from "../../hooks/useActiveSession.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { aliasBrickInput } from "../../lib/banzhuan-mention.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { submitMessage } from "../../lib/submit-message.js";
import { stopAllVoice } from "../../voice/play-voice.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { AuraVisual } from "../UtilityRail/AuraVisual.js";
import { ContextIndicator } from "./ContextIndicator.js";
import { SendArrowIcon } from "./SendArrowIcon.js";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

/** Whether the ghost hint should show: caret is at the END of `value`, the
 *  char before it is `@`, that `@` is at the start or preceded by whitespace
 *  (a boundary), and it was not Esc-dismissed. */
function shouldHint(
  value: string,
  caret: number | null,
  escIdx: number,
): boolean {
  if (caret === null || caret !== value.length) return false;
  const at = caret - 1;
  if (at < 0 || value[at] !== "@") return false;
  if (at !== 0 && !/\s/.test(value[at - 1] ?? "")) return false;
  if (escIdx === at) return false;
  return true;
}

/** How long the rewind notice's slide-out runs before it unmounts. Must match
 *  the `.composer-notice.is-exiting` animation duration in reference-ux.css. */
const NOTICE_EXIT_MS = 240;

export function Composer(): JSX.Element {
  const t = useT();
  const { bridge, sessionStore } = useHertaBridge();
  const { composerRef, sendButtonRef } = useWorkspaceRefs();
  // Selector-based: the composer needs a handful of cold fields; the whole-
  // snapshot subscription re-rendered it (and its highlight overlay) per delta.
  const { status, overlay, sessionId, composerDraft, composerNotice } =
    useSessionSelector(
      (s) => ({
        status: s.status,
        overlay: s.overlay,
        sessionId: s.sessionId,
        composerDraft: s.composerDraft,
        composerNotice: s.composerNotice,
      }),
      shallowEqualObjects,
    );
  // The conversation's language drives the 板砖→Brick surface alias: in an EN
  // session the ghost/insert use "brick" and a typed "@brick" is translated to
  // the wire token "@板砖" before dispatch.
  const lang = useSessionLang();
  const [text, setText] = useState("");
  // Focus-keyed height (owner 2026-08-20, superseding shrink-after-send):
  // the composer RESTS shrunk and holds full height only while it is
  // engaged. The two sides are deliberately ASYMMETRIC:
  //   - EXPAND only when the TEXTAREA gains focus (the caret is the
  //     expansion) — focus landing on the attach/send button from outside
  //     must NOT expand, or clicking attach in the resting state bounced
  //     the composer up and back down around the native file dialog
  //     (owner screenshots, same day).
  //   - HOLD while focus stays anywhere inside the FORM: clicking attach
  //     from the textarea blurs it while the pointer is still inside the
  //     composer, and shrinking there would move the button 18px under the
  //     cursor mid-click. Only a blur that leaves the form shrinks.
  // The disable-blur at turn start shrinks (set on the busy edge below —
  // Chrome fires no blur for it); an unsent draft keeps its first line
  // visible and survives; the turn-end auto-refocus expands again.
  const [focusWithin, setFocusWithin] = useState(false);
  // While the OS file picker is up it steals WINDOW focus, firing
  // focusout/focusin churn that says nothing about the user's intent —
  // freeze the height until the picker resolves (then the caret handoff
  // below decides).
  const pickerOpen = useRef(false);
  const [hintActive, setHintActive] = useState(false);
  // The index of an `@` whose hint the user dismissed with Esc; re-enabled
  // once the text changes. -1 means "none dismissed".
  const escDismissed = useRef(-1);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // After a Tab insertion we must restore the caret AFTER the inserted 板砖,
  // applied post-render via this ref (React owns the controlled value).
  const pendingCaret = useRef<number | null>(null);
  const busy = status !== "idle";
  const suppressed = overlay?.kind === "pending-permission";

  // Shared submit path for the ↑ button (form submit) and Enter-to-send.
  const doSubmit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    // EN surface alias: translate a typed "@brick" (any case) back to the wire
    // trigger "@板砖" BEFORE it enters the record/dispatch — code spans exempt
    // (a backticked `@brick` is quotation). See aliasBrickInput, kept in
    // lockstep with the CLI's converter of the same name.
    const dispatched = aliasBrickInput(trimmed, lang);
    // Optimistic echo + dispatch. With no DeepSeek key set, the backend
    // reports needsKey and submitMessage opens the no-key onboarding card.
    submitMessage(bridge, sessionStore, dispatched);
    setText("");
    // The rewind file-edit notice persists through editing; clear it once the
    // (re-)send actually goes out (a session switch clears it via onReset).
    if (composerNotice !== null) sessionStore.clearComposerNotice();
  };

  // Refocus the input when a turn ends: `disabled={busy}` blurs it at turn
  // start, and without this every exchange needed a click before typing.
  // Skipped while an approval gate suppresses the composer (the panel owns
  // focus then) — the gate's `resolved` flips status later anyway.
  const prevBusy = useRef(false);
  useEffect(() => {
    const was = prevBusy.current;
    prevBusy.current = busy;
    if (!was && busy) {
      // Turn start disables the textarea, which SILENTLY drops focus —
      // Chrome moves activeElement off a disabled element without firing
      // blur/focusout (verified live 2026-08-20), so the form handler never
      // learns focus left. Clear the state here: the composer is shrunk for
      // the whole reply, which is the reading-room the shrink exists for.
      setFocusWithin(false);
    }
    if (was && !busy && !suppressed) {
      taRef.current?.focus();
      // "Caret back, ready to type" includes the height: expand directly
      // rather than relying on the focus() call's focusin reaching the form
      // handler (browsers deliver it; jsdom does not, and a focus() that
      // fails to take should still leave the composer ready).
      setFocusWithin(true);
    }
  }, [busy, suppressed]);

  // The rewind file-edit notice is animated in AND out. composerNotice (store) is
  // the source; `noticeText` is the locally-held copy that stays mounted through
  // the slide-out (React would otherwise unmount it instantly, skipping the exit).
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [noticeExiting, setNoticeExiting] = useState(false);
  const noticeShown = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  // The Composer stays mounted across session changes and the disconnected
  // state, so its local draft would otherwise leak into the next session (type
  // text, delete the session, connect a new one → the old text reappears).
  // Reset whenever the active session changes — a new/other session starts empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on sessionId; the setters/ref are stable
  useEffect(() => {
    setText("");
    setHintActive(false);
    escDismissed.current = -1;
  }, [sessionId]);

  useEffect(() => {
    if (pendingCaret.current !== null && taRef.current) {
      taRef.current.setSelectionRange(
        pendingCaret.current,
        pendingCaret.current,
      );
      pendingCaret.current = null;
    }
  });

  // Adopt a rewind-restored draft: a rewound turn returns its user text here for
  // editing. Load it into the input, focus + place the caret at the end, then
  // clear the one-shot so it isn't re-applied on the next render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the draft signal; setters/store/ref are stable
  useEffect(() => {
    if (composerDraft === null) return;
    setText(composerDraft);
    setHintActive(false);
    pendingCaret.current = composerDraft.length;
    taRef.current?.focus();
    sessionStore.clearComposerDraft();
  }, [composerDraft]);

  // Drive the notice's enter/exit. On show: mount with the in-animation, cancel
  // any pending unmount. On clear: play the out-animation, then unmount after it
  // finishes. `noticeShown`/`noticeTimer` are refs so this keys only on the store
  // value (the setters/refs are stable, so deps stay exhaustive).
  useEffect(() => {
    if (composerNotice !== null) {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
      setNoticeText(composerNotice);
      setNoticeExiting(false);
      noticeShown.current = true;
    } else if (noticeShown.current) {
      setNoticeExiting(true);
      noticeTimer.current = window.setTimeout(() => {
        setNoticeText(null);
        setNoticeExiting(false);
        noticeShown.current = false;
        noticeTimer.current = null;
      }, NOTICE_EXIT_MS);
    }
  }, [composerNotice]);

  // Clear the pending unmount timer if the Composer itself unmounts mid-exit.
  useEffect(
    () => () => {
      if (noticeTimer.current !== null)
        window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // ── Attachments (ADR 0033) ────────────────────────────────────────────────
  // `dragDepth` counts enter/leave rather than using a boolean: dragging over a
  // child element fires leave-then-enter, and a boolean flickers the highlight
  // off on every internal boundary crossing.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // A file drag over the composer also expands it — a drop target should
  // not be at its smallest exactly while the user is aiming at it.
  const shrunk = !focusWithin && !dragOver;

  const sendAttachments = (paths: readonly string[]): void => {
    if (paths.length === 0 || sessionId === null) return;
    void bridge
      .attachFiles(sessionId, paths)
      .then((r) => {
        // Refusals are SHOWN. `attachFiles` is idle-only, and a drop that
        // silently did nothing mid-turn would read as a broken drop target
        // (the same no-op-silently failure the M6 audit found on setWorkspace).
        if (!r.ok) {
          sessionStore.setComposerNotice(
            r.message === "a turn is in progress"
              ? t("composer.attach.busy")
              : r.message === "too many files at once"
                ? t("composer.attach.tooMany")
                : t("composer.attach.failed"),
          );
        }
      })
      // A rejected IPC call (handler threw) must land in the same notice, not
      // as an unhandled rejection with a drop that looked like it worked.
      .catch(() => sessionStore.setComposerNotice(t("composer.attach.failed")));
  };

  const onPickAttachments = (): void => {
    pickerOpen.current = true;
    void bridge
      .pickAttachments()
      .then((paths) => {
        if (paths !== null) sendAttachments(paths);
      })
      .finally(() => {
        pickerOpen.current = false;
        // Caret handoff: whether the user picked files or cancelled, the
        // next act is typing — put the caret in the field. Any expansion the
        // dialog's close causes is then explained by a visible caret (the
        // owner's report: cancel re-expanded the composer with focus stuck
        // on the attach button and no caret anywhere). Explicit set beside
        // focus(), same rationale as the turn-end refocus.
        taRef.current?.focus();
        setFocusWithin(true);
      });
  };

  return (
    <form
      ref={composerRef}
      className={`composer${shrunk ? " is-shrunk" : ""}${suppressed ? " is-suppressed" : ""}${dragOver ? " is-dragover" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        doSubmit();
      }}
      onBlur={(e) => {
        // Height frozen while the OS picker is up — its window-focus churn
        // is not the user leaving the composer.
        if (pickerOpen.current) return;
        // Focus moving BETWEEN the form's own controls (textarea → attach,
        // attach → send) fires blur with the new holder as relatedTarget —
        // still inside, still expanded. Only a genuine exit (relatedTarget
        // outside the form, or null for a click on non-focusable ground /
        // the window deactivating) shrinks.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setFocusWithin(false);
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        // Without preventDefault the browser navigates to the dropped file and
        // the drop handler never runs — the classic silent-nothing-happens.
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        // Electron 43 removed File.path; only the preload can resolve a real
        // path (webUtils), so the File objects never leave this handler.
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => bridge.pathForFile(f))
          .filter((p) => p.length > 0);
        sendAttachments(paths);
        // Same caret handoff as the picker: after a drop you type the
        // message that goes with the files. Busy drops surface a refusal
        // notice instead — a disabled textarea can't take the caret.
        if (!busy) {
          taRef.current?.focus();
          setFocusWithin(true);
        }
      }}
    >
      {/* Herta's tide wave living at the composer's floor (glass-wave merge,
          2026-07-05): inside the composer it tracks the composer's width when
          sidebars change, hides with is-suppressed during approval gates, and
          leaves the space above free for pop-ups. Decorative, behind the
          input/send (which are positioned), clipped by its own radius. */}
      <div className="composer-wave" aria-hidden="true">
        <AuraVisual />
      </div>
      {noticeText !== null && (
        <div
          className={`composer-notice${noticeExiting ? " is-exiting" : ""}`}
          role="status"
        >
          {noticeText}
        </div>
      )}
      <div className="composer-input-wrap">
        <div className="composer-highlight" aria-hidden="true">
          {renderBanzhuanText(text, "composer", lang)}
          {hintActive && (
            <span className="composer-ghost">
              {lang === "en" ? "brick" : "板砖"}
            </span>
          )}
        </div>
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={t("composer.placeholder")}
          onFocus={() => setFocusWithin(true)}
          value={text}
          onChange={(e) => {
            escDismissed.current = -1;
            setText(e.target.value);
            setHintActive(
              shouldHint(e.target.value, e.target.selectionStart, -1),
            );
          }}
          onSelect={(e) =>
            setHintActive(
              shouldHint(
                e.currentTarget.value,
                e.currentTarget.selectionStart,
                escDismissed.current,
              ),
            )
          }
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              // IME safety (Chinese input): Enter during composition confirms
              // the candidate, it does NOT send. isComposing covers the spec
              // path; keyCode 229 covers engines that fire the keydown after
              // compositionend with isComposing already false.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              doSubmit();
              return;
            }
            if (e.key === "Tab" && hintActive) {
              e.preventDefault();
              const caret = e.currentTarget.selectionStart ?? text.length;
              // EN completes to "brick" (→ "@brick", translated to the wire
              // token on submit); zh completes to the literal "板砖".
              const insert = lang === "en" ? "brick" : "板砖";
              const next = `${text.slice(0, caret)}${insert}${text.slice(caret)}`;
              pendingCaret.current = caret + insert.length;
              setText(next);
              setHintActive(false);
              return;
            }
            if (e.key === "Escape" && hintActive) {
              e.preventDefault();
              const caret = e.currentTarget.selectionStart ?? text.length;
              escDismissed.current = caret - 1; // the @ index
              setHintActive(false);
            }
          }}
          onScroll={(e) => {
            const hl = e.currentTarget
              .previousElementSibling as HTMLElement | null;
            if (hl) {
              hl.scrollTop = e.currentTarget.scrollTop;
              hl.scrollLeft = e.currentTarget.scrollLeft;
            }
          }}
          rows={2}
          aria-label={t("composer.aria")}
          disabled={busy}
        />
      </div>
      {/* ONE persistent button that morphs between SEND (↑) and STOP (■).
          While a turn runs it is wired to bridge.interrupt — previously a
          hung turn left the composer disabled forever with no affordance at
          all. The two glyphs are stacked in the same grid cell and
          cross-fade/scale via `.is-stop` (see reference-ux.css), so the mode
          change reads as the button transforming, not two buttons being
          swapped (user 2026-07-04). The stop square is a sized <span>, not a
          ■ text glyph — font metrics rendered the glyph tiny and
          inconsistent across fonts. */}
      {/* Attach. Disabled during a turn for the same reason the main-process
          handler refuses then: the ingest rides an out-of-turn record append.
          Showing it disabled beats letting a click produce a refusal notice.
          The hint is the app's styled Tooltip like the topbar icons — the
          first cut used the native `title`, which renders as the OS's own
          beige box and matches nothing (owner 2026-08-10). placement="top"
          because the composer sits at the window's bottom edge; align="end"
          because the button sits near the right one. */}
      <Tooltip
        label={t("composer.attach")}
        sub={t("composer.attach.formats")}
        placement="top"
        align="end"
      >
        <button
          type="button"
          className="composer-attach"
          aria-label={t("composer.attach")}
          disabled={busy}
          onClick={onPickAttachments}
        >
          {/* viewBox origin nudged by the path's own ink offset (owner asked
              me to check this button, 2026-08-10). Measured with getBBox: the
              paperclip's ink spans y 1.70–13.96 in a 0–14 box, so its centre
              sits 0.83 units low — ~0.95px at this size — and 0.32 right. The
              <svg> element is perfectly centred in the button; the drawing
              inside it is not, which no layout measurement can see. Shifting
              the window by that offset lands ink centre on box centre without
              touching the scale. */}
          <svg viewBox="0.32 0.83 14 14" aria-hidden="true" focusable="false">
            <path d="M9.5 4.2 5.3 8.4a1.6 1.6 0 0 0 2.3 2.3l4.2-4.2a3 3 0 0 0-4.2-4.2L3.2 6.6a4.3 4.3 0 0 0 6.1 6.1l3.4-3.4" />
          </svg>
        </button>
      </Tooltip>
      <ContextIndicator
        sessionId={sessionId}
        busy={busy}
        onQueued={(notice) => sessionStore.setComposerNotice(notice)}
      />
      <button
        ref={sendButtonRef}
        type={busy ? "button" : "submit"}
        className={`composer-send${busy ? " is-stop" : ""}`}
        aria-label={busy ? t("composer.stop") : t("composer.send")}
        disabled={!busy && text.trim().length === 0}
        onClick={
          busy
            ? () => {
                // Cut any in-flight voice ON the click, not via the turn
                // lifecycle: the opening's interrupt-as-SKIP finishes the
                // turn normally (`finished`, no `failed`), so useVoiceCues'
                // failed-cut never fires and the opening clip talked through
                // the skip (user 2026-07-13). The stop click IS the intent —
                // silence immediately, then abort the turn.
                stopAllVoice();
                void bridge.interrupt();
              }
            : undefined
        }
      >
        <span
          className="composer-send__glyph composer-send__glyph--send"
          aria-hidden="true"
        >
          <SendArrowIcon />
        </span>
        <span
          className="composer-send__glyph composer-send__glyph--stop"
          aria-hidden="true"
        />
      </button>
    </form>
  );
}
