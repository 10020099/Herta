import type { TerminalRecordBlock } from "@herta/app-server";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { useNow } from "../../hooks/useNow.js";
import { usePresence } from "../../hooks/usePresence.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import type { Locale } from "../../ipc/bridge-types.js";
import { dealiasBrickDraft } from "../../lib/banzhuan-mention.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { ActivityBlock } from "./ActivityBlock.js";
import { ConversationPinProvider } from "./ConversationPin.js";
import {
  ENTRANCE_DURATION_MS,
  ENTRANCE_STAGGER_MS,
  planStaggerEntrance,
} from "./conversation-entrance.js";
import { formatBubbleTime, type TimeTFn } from "./format-time.js";
import { GalaxyTravelRow } from "./GalaxyTravelRow.js";
import { activityHasTerminalMarker, groupRecord } from "./group-record.js";
import { HertaBubble } from "./HertaBubble.js";
import { MorphClone } from "./MorphClone.js";
import { PendingActivity } from "./PendingActivity.js";
import { planContext } from "./plan-context.js";
import { RecapCompactRow } from "./RecapCompactRow.js";
import { StreamingReply } from "./StreamingReply.js";
import { SupervisorHoldRow } from "./SupervisorHoldRow.js";
import { type ScrollGlideHandle, startScrollGlide } from "./scroll-glide.js";
import { TopicRail } from "./TopicRail.js";
import { TurnFailedRow } from "./TurnFailedRow.js";
import {
  headroomFor,
  needsRoom,
  preGlideScrollTop,
  releasedExtent,
  targetExtentFor,
} from "./turn-headroom.js";
import { UserBubble } from "./UserBubble.js";
import {
  E_OUT_CUBIC,
  easeOutCubic,
  easeOutQuart,
  useRiseAnimation,
} from "./useRiseAnimation.js";
import { useScrollEdges } from "./useScrollEdges.js";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

// The composer "glass" frost should only read while the bubble is lifting off
// the input — not for the bubble's whole rise. Drop it shortly after the lift
// so the composer isn't dimmed for the full travel.
const GLASS_MS = 150;

// Small grace before the galaxy row APPEARS, so a long-session recap can lead.
// The primary fix is in the backend: compaction now runs BEFORE intent-routing,
// so `recap.compaction start` fires at turn-start and (with motion) lands well
// before the ~860ms send-morph settles → the recap row leads, no flash. This
// grace is the remaining safety net for the reduced-motion path, where there is
// no send-morph to cover the few-tens-of-ms event latency. Hiding is immediate.
//
// Raised 200→400 (user 2026-07-31): a fast first token lands 300–500ms after
// the settle, and a 200ms trigger put the row up just in time to be loud-cut
// mid-entrance — the "quick flash before 处理中" report. Waits that deserve
// the row are seconds long; starting it 200ms later costs nothing.
export const GALAXY_APPEAR_DELAY_MS = 400;

// Once the in-flight indicator IS up, it stays up this long. A @板砖 turn
// whose dispatch lands quickly used to flash it for under half a second before
// the coprocessor's own row replaced it (user 2026-07-30) — too short to read,
// so it registered as a glitch rather than as a message. 800ms covers the
// row's own 450ms entrance plus enough stillness to actually read it.
//
// The hold is deliberately NOT a blanket one: see `inFlightVisible` for why a
// stream or a morph still hides it in the same render.
export const IN_FLIGHT_MIN_VISIBLE_MS = 800;

// How long the row stays mounted fading OUT after a QUIET hide (user
// 2026-07-31: the galaxy→处理中 swap was a hard same-commit switch). Matches
// the .status-row.is-exiting CSS transition. Loud hides (a stream, a morph)
// still unmount in the same render — that boundary is load-bearing for the
// incoming-rise morph measurement (bug 2026-07-10) and stays instant.
export const IN_FLIGHT_EXIT_MS = 220;

// How long the VISIBLE reveal must sit still (no revealed-text growth) during
// a pending supervisor judgment before the 伽马风暴 row appears. Keyed to the
// reveal, not the judgment (user 2026-07-10): the supervisor starts the moment
// generation completes, but the paced reveal often has a BACKLOG still typing
// — visible progress needs no explanation. Only a genuinely stuck cursor earns
// the hint. Hiding is immediate on the verdict.
export const SUPERVISOR_HINT_DELAY_MS = 2000;
// Poll cadence for the stall check above (a ref timestamp, not state, tracks
// growth — polling avoids per-frame re-renders).
const SUPERVISOR_HOLD_POLL_MS = 250;

// How close to the bottom (px) still counts as "pinned" for autoscroll —
// generous enough that sub-pixel scroll rounding and the fog strip never
// unpin, small enough that one wheel notch upward does.
const PIN_THRESHOLD_PX = 48;

// How long the send glide owns the scroller (turn headroom, 2026-07-29).
// Chromium's smooth scroll runs a few hundred ms for a pane-sized move; this
// is the outer bound after which control returns to geometry and the landing
// is re-asserted.
export const GLIDE_WINDOW_MS = 700;
/** Travel time of the outgoing send rise. The page's climb into the reserved
 *  room waits for this flight to land (2026-07-30), so the send's fallback
 *  release has to outlast it — hence a named constant rather than a literal at
 *  the `rise.start` call. */
export const OUTGOING_FLIGHT_MS = 860;

/** Per-row crash fallback (audit 2026-07-13 T2.2): the row renderers are
 *  fed model-shaped record blocks every turn, so a malformed one must cost
 *  one muted line — not unmount the whole conversation. */
function RowRenderError(): JSX.Element {
  const t = useT();
  return (
    <div className="row-render-error" role="note">
      {t("conversation.rowError")}
    </div>
  );
}

function renderBlock(
  block: TerminalRecordBlock,
  index: number,
  now: number,
  locale: Locale,
  t: TimeTFn,
  // Conversation language, for the 板砖→Brick display alias on the bubbles.
  lang: "zh" | "en",
  // Set only on the LATEST user block when idle — wires its rewind control.
  onRewind?: () => void,
): JSX.Element | null {
  // Per-block timestamp (Slice 4): `at` is stamped at the output boundaries
  // (live sink emit + JSONL persist), so each bubble shows its own time.
  // Pre-timestamp blocks lack `at` → the bubble hides its timestamp line
  // rather than fabricating a shared "now" (the old all-same bug). The label is
  // adaptive (just now / N min ago / time / date+time) relative to `now`.
  const timestamp =
    block.at !== undefined
      ? formatBubbleTime(block.at, now, locale, t)
      : undefined;
  switch (block.kind) {
    case "user":
      return (
        <UserBubble
          key={index}
          absIndex={index}
          text={block.text}
          timestamp={timestamp}
          lang={lang}
          {...(onRewind !== undefined ? { onRewind } : {})}
        />
      );
    case "herta":
      if (block.surface === "thought") return null; // per SPEC D8
      return (
        <HertaBubble
          key={index}
          text={block.text}
          timestamp={timestamp}
          lang={lang}
        />
      );
    default:
      return null;
  }
}

// memo (user profile 2026-07-12): Conversation takes no props, so every
// PARENT re-render — notably the sidebar toggle flipping Workbench state,
// which profiled as an 89ms long task on the click — re-rendered the whole
// row tree for nothing. Store updates still flow via useActiveSession.
export const Conversation = memo(function Conversation(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const {
    record,
    recordStart,
    status,
    streamingText,
    retryText,
    pendingUser,
    retracting,
    retractKeepLen,
    turnStartedAt,
    backendStartedAt,
    backendActive,
    backendInFlight,
    recapCompacting,
    supervisorChecking,
    sessionId,
    pendingJump,
    turnFailed,
    turnFailedStatus,
    turnFailedProviderCode,
    topics,
    lang,
  } = useActiveSession();
  const { bridge, sessionStore } = useHertaBridge();
  const reduced = useReducedMotion();
  // Coarse clock so adaptive timestamps ("just now" → "N min ago") refresh while
  // a session sits open. 30s granularity is plenty (the finest label is minutes)
  // and the timestamps are hover-only, so this is cheap background churn.
  const now = useNow(30_000);
  // The per-FRAME reveal (useRevealedText / useRetractMorph) lives in the
  // StreamingReply leaf, not here: its state commits once per rAF frame while
  // tokens stream, and hosting it in Conversation re-rendered the ENTIRE
  // conversation (every historical bubble) 60×/s. Conversation re-renders per
  // DELTA (streamingText identity), which the memoized rows absorb.

  // Outgoing send morph: on the pendingUser null→value edge, mount a flying
  // clone in the workspace overlay and rise it from the composer to its
  // resting slot (crisp left/top). The flow bubble stays hidden until settle.
  const { composerRef, overlayRef } = useWorkspaceRefs();
  const outgoingRise = useRiseAnimation();
  const incomingRise = useRiseAnimation();
  /** The `.conversation-flow` column — the morphs watch its WIDTH so a
   *  container reflow mid-flight (sidebar toggle, rail gutter) settles them
   *  early instead of landing at the pre-reflow slot. */
  const flowRef = useRef<HTMLDivElement>(null);
  const cloneRef = useRef<HTMLDivElement>(null);
  const pendingUserBubbleRef = useRef<HTMLDivElement>(null);
  const [outgoingClone, setOutgoingClone] = useState<{
    text: string;
  } | null>(null);
  const [hidePendingUser, setHidePendingUser] = useState(false);
  const prevPendingUser = useRef<string | null>(null);
  /** Whether THIS send will actually fly a clone (set by the detection layout
   *  effect below, read by the send effect in the same commit). The sequenced
   *  travel is handed to the flight's settle, so a send with no flight has to
   *  keep travelling immediately or the reserved room never comes on screen. */
  const outgoingFlightArmedRef = useRef(false);

  // Detection: on the pendingUser null→value edge, mount the flying clone +
  // hide the flow bubble. Geometry/animation happens in the effect below,
  // AFTER the clone has committed (so cloneRef is attached).
  // LAYOUT effect, deliberately: a passive useEffect runs after the browser
  // paints, so the flow bubble got one painted frame at its final position
  // before the hide flag landed — a visible flash, then the rise replayed
  // from the composer (seen live 2026-06-13). Setting the flag before paint
  // means the bubble is never painted until the morph settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the pendingUser null→value edge
  useLayoutEffect(() => {
    const appeared = prevPendingUser.current === null && pendingUser !== null;
    prevPendingUser.current = pendingUser;
    if (pendingUser === null) {
      outgoingRise.cancel();
      setOutgoingClone(null);
      setHidePendingUser(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    if (!appeared) return;
    if (
      overlayRef.current === null ||
      composerRef.current === null ||
      reduced ||
      // Reading history: the send no longer yanks the pane (see the send
      // effect), so this clone's destination — the flow bubble's slot — is
      // below the fold. Flying to it would launch the bubble off the bottom
      // edge of a view the reader never asked to leave. Let the bubble land
      // in the flow unseen, exactly like the reduced-motion path.
      //
      // A DISCLOSURE unpin does not count as reading history, and must be
      // tested the same way here as in the send effect below — the two
      // decisions have to agree or the send hands its travel to a flight that
      // was never armed. Expanding a detail pane and then sending lost the
      // animation entirely until this matched (owner 2026-08-10).
      (!pinnedRef.current && !syntheticUnpinRef.current)
    ) {
      // No overlay/composer or reduced motion → the flow bubble shows directly,
      // and nothing will fly. Recorded because the send effect below decides
      // whether to hand its travel to a flight that may not exist, and this
      // layout effect runs FIRST in the same commit, so the answer is current.
      outgoingFlightArmedRef.current = false;
      return;
    }
    outgoingFlightArmedRef.current = true;
    setHidePendingUser(true);
    setOutgoingClone({ text: pendingUser });
  }, [pendingUser, reduced]);

  // Animate once the clone has mounted (cloneRef attaches only after the portal
  // commits — measuring in the detection effect via rAF raced the commit and
  // left the clone unpositioned at the overlay's top-left). FLIP-style: measure
  // the real flow bubble's slot (held in layout via visibility:hidden) and rise
  // the clone to exactly that rect so it lands where the bubble actually goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (outgoingClone === null) return;
    const el = cloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = pendingUserBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    // Diagonal lift: start at the composer's left (the input), settle at the
    // flow bubble's actual slot (right-aligned, wherever it lands in the flow).
    const startLeft = comp.left + 20 - ws.left;
    const startTop = comp.top - ws.top + 6;
    const targetLeft = dest.left - ws.left;
    // `dest` is where the slot IS, and that is where the clone lands (2026-07-30).
    // It used to subtract the scroll still owed by an in-flight send glide,
    // because the page climbed into the reserved room WHILE the bubble crossed
    // it — the clone had to aim at where the slot would end up. The two are
    // sequenced now: the send parks at the bottom of the real content and the
    // climb waits for this flight's settle, so nothing is owed and the slot
    // cannot move underneath it.
    const targetTop = dest.top - ws.top;
    el.style.left = `${Math.round(startLeft)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    outgoingRise.start({
      el,
      from: { left: startLeft, top: startTop },
      to: { left: targetLeft, top: targetTop },
      durationMs: OUTGOING_FLIGHT_MS,
      easing: easeOutCubic,
      // Runs the flight on the COMPOSITOR (see useRiseAnimation): this rise
      // overlaps the heaviest main-thread moment in the app — the committed
      // turn's style/layout/paint plus, on a full page, the headroom glide —
      // and on a slow machine it used to freeze with it.
      cssEasing: E_OUT_CUBIC,
      // A sidebar toggle or the rail gutter easing in mid-flight moves the
      // slot with no window resize — settle early on a flow WIDTH change
      // (deferred-fix 2026-07-31).
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        setHidePendingUser(false);
        setOutgoingClone(null);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [outgoingClone]);

  // Incoming rise-while-streaming morph: on the streamingText null→value edge,
  // mount a clone that mirrors the live tokens and rise it from behind the
  // composer to its resting slot (mirrors the outgoing morph). The flow
  // streaming bubble stays hidden until settle, where it keeps streaming.
  const incomingCloneRef = useRef<HTMLDivElement>(null);
  const streamingBubbleRef = useRef<HTMLDivElement>(null);
  const [incomingClone, setIncomingClone] = useState(false);
  const [hideStreaming, setHideStreaming] = useState(false);
  const prevStreaming = useRef<string | null>(null);

  // Detection: on the streamingText null→value edge, mount the incoming clone +
  // hide the flow streaming bubble. The fixed width pins wrap so the bubble
  // doesn't reflow while it fills during the rise.
  // LAYOUT effect for the same reason as the outgoing detection above: the
  // hide flag must land before the browser paints the freshly-mounted flow
  // bubble, or it flashes at its resting slot for one frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the streamingText null→value edge
  useLayoutEffect(() => {
    const appeared = prevStreaming.current === null && streamingText !== null;
    prevStreaming.current = streamingText;
    if (streamingText === null) {
      incomingRise.cancel();
      setIncomingClone(false);
      setHideStreaming(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    // `retracting` is defensive: retry deltas buffer in retryText, so
    // streamingText can't do a null→value edge mid-retract.
    if (!appeared || retracting) return;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    if (composer === null || overlay === null || reduced) return;
    // The clone's size is driven by the shared measurer effect (it mirrors the
    // in-place bubble); here we only flag it active and hide the flow bubble
    // until the rise settles.
    setHideStreaming(true);
    setIncomingClone(true);
  }, [streamingText, reduced, retracting]);

  // Animate once the incoming clone has mounted (same rationale as outgoing).
  // FLIP-style: measure the real streaming bubble's slot (held in layout via
  // visibility:hidden) for BOTH left and top, so the clone aligns with the
  // indented Herta column and rises to the bubble's actual resting slot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (!incomingClone) return;
    const el = incomingCloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = streamingBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    const h = el.offsetHeight;
    const left = dest.left - ws.left; // align to the Herta column
    const startTop = comp.bottom - ws.top - h * 0.32; // behind the composer
    // The send's climb into the reserved room may still be running (2026-07-30):
    // it now starts at the outgoing flight's settle rather than at send, which
    // puts it squarely in the window where a first delta arrives. Every pixel
    // of scroll still owed lifts this slot by one, so aim at where it will be —
    // the compensation the outgoing flight no longer needs, moved to the flight
    // that now needs it. Zero whenever no scroll is pending, which keeps every
    // other path byte-identical.
    const pane = scrollRef.current;
    const owedScroll =
      pane === null || !glidingRef.current
        ? 0
        : Math.max(0, pane.scrollHeight - pane.clientHeight - pane.scrollTop);
    const targetTop = dest.top - ws.top - owedScroll; // the real flow slot
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    incomingRise.start({
      el,
      from: { left, top: startTop },
      to: { left, top: targetTop },
      durationMs: 760,
      easing: easeOutQuart,
      anchor: "bottom",
      // The aim above compensates for the climb still owed — but the two
      // clocks are independent, and a flight that ends mid-climb would swap
      // onto a slot still travelling toward the aimed position (deferred-fix
      // 2026-07-31: a fast first token made the bubble visibly drop at
      // hand-off, then get dragged back up). Hold at the aimed slot until
      // the climb's own lifecycle ends: converge (seamless swap), the
      // runaway cap, or a user takeover — all flip glidingRef, and every
      // cancel path (session switch, rePin, unmount) clears it too.
      holdSettle: () => glidingRef.current,
      // Same early settle on a flow width change as the outgoing flight.
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        setHideStreaming(false);
        setIncomingClone(false);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [incomingClone]);

  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fog = useScrollEdges(scrollRef);

  /**
   * Put the view at the scroller's TRUE bottom.
   *
   * Not `endRef.scrollIntoView({block:"end"})`, which is what every one of
   * these sites used to do and is subtly not the same thing: `scrollIntoView`
   * aligns the ELEMENT with the scrollport's edge, and the scroller's bottom
   * padding (--approval-reserve, which the approval panel publishes) lies
   * inside the scrollport — so aligning `endRef` leaves that padding
   * unscrolled and lands short of the bottom by exactly the reserve.
   *
   * That shortfall was the approval-panel drift (user 2026-07-30, measured):
   * with a reservation held, the panel opening scrolled the pinned view 200px
   * short of the bottom, the resulting scroll event let the ratchet read it as
   * the reader stepping out of the reserved room and SPEND 200px of it, and the
   * anchored message walked down — then again when the panel closed and the
   * shrinking extent clamped the scroll. 399px over two steps, none of it
   * recoverable, because a spent reservation does not come back.
   *
   * `scrollHeight - clientHeight` is the bottom by definition, padding and all.
   */
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, []);

  // ── Pinned autoscroll ──────────────────────────────────────────────────
  // Follow the stream to the bottom ONLY while the user is already there.
  // The old unconditional scrollIntoView fired on every reveal frame, so
  // scrolling up to reread during a streaming reply was impossible — the
  // pane snapped back to the bottom ~60×/s. `pinned` flips false when the
  // user scrolls away from the bottom and true when they return; sending a
  // message and switching sessions re-pin explicitly (your own actions
  // always land you at the bottom).
  const pinnedRef = useRef(true);
  // Jump-to-latest chip (2026-07-11): `pinnedRef` mirrored as STATE plus
  // "new content arrived below" together mount the 回到底部 chip. The ref
  // stays the per-frame source of truth (scroll handler and reveal frames
  // read it without re-rendering); the state exists only for the chip.
  const [pinnedState, setPinnedState] = useState(true);
  const [newBelow, setNewBelow] = useState(false);
  // True from a chip click until the smooth glide reaches the bottom (or the
  // fallback timeout fires) — growth DURING the glide must not re-light the
  // chip, and scrollToEndIfPinned must not snap over the glide.
  const jumpingRef = useRef(false);
  // True while the unpin came from a DISCLOSURE (activity-history / diff
  // expand), not from the user scrolling away (user bug 2026-07-24: expand
  // the 板砖 row while Herta's bubble streams → every reveal frame lit the
  // chip although the reader never left the bottom). A synthetic unpin keeps
  // the follow OFF (its whole purpose) but must not light the chip; the
  // FIRST real scroll event hands control back to geometry and re-arms the
  // chip machinery. loadEarlier / jumpToTopic set pinnedRef directly — their
  // unpins are user navigation and keep lighting the chip as before.
  const syntheticUnpinRef = useRef(false);
  const jumpTimerRef = useRef<number | null>(null);
  /** Handle for the topic-jump's anchor poll, so a session change can cancel
   *  a still-pending tick (audit 2026-07-24, M4). */
  const jumpPollRef = useRef<number | null>(null);
  // Frozen while a morph clone is in flight: both rises measure their landing
  // slot ONCE at flight start, so scrolling the container mid-flight (e.g. the
  // first streaming tokens growing the hidden slot) moves the slot out from
  // under the clone — a visible jump at hand-off. The settle effect below
  // catches the scroll up once the clone lands.
  const morphInFlightRef = useRef(false);
  /** True while the SEND glide is carrying the view to the newly reserved
   *  bottom (turn headroom). Every frame of it fires a scroll event that
   *  geometry reads, correctly, as "away from the bottom" — and unpinning
   *  there is wrong twice over: the reader never left (we moved them), and
   *  it disarms the follow that is supposed to land them. Left unguarded it
   *  also loses the landing outright, since content growing mid-glide (the
   *  first tokens, an interrupted turn's rows) moves the bottom out from
   *  under a native smooth scroll that cannot retarget: the glide stops
   *  short, pinned is false, and nothing corrects it. */
  const glidingRef = useRef(false);
  /** A send reserved room and left its climb for the flight's settle
   *  (2026-07-30). Consumed by `runPendingGlide`. */
  const pendingGlideRef = useRef(false);
  /** Where the park put the scroller, so its own settle-write's scroll event
   *  is distinguishable from the reader's hand (see the scroll handler). */
  const parkedScrollTopRef = useRef(0);
  /** The running damped climb (scroll-glide.ts), for teardown: a session
   *  switch or a newer glide must stop the rAF loop, not just flip flags —
   *  a loop left running writes scrollTop against whatever is on screen. */
  const scrollGlideRef = useRef<ScrollGlideHandle | null>(null);
  // Unmount mid-climb: the loop holds `el` alive and keeps scrolling it.
  useEffect(
    () => () => {
      scrollGlideRef.current?.cancel();
      scrollGlideRef.current = null;
    },
    [],
  );
  /** Indirection so the scroll handler (installed once, above the headroom
   *  block) can reach a callback declared below it. Assigned every render;
   *  the handler only ever calls the current one. */
  const ratchetHeadroomRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      // Our own glide, not the reader's hand — leave every flag alone and
      // let the settle catch-up finish the job.
      if (glidingRef.current) {
        // …unless this is the PARK window (flight in the air, climb queued,
        // no glide running): nothing of ours is writing the scroller then,
        // so a scroll that isn't the park's own settle-write is the reader —
        // and they outrank the queued climb (review 2026-07-31: a wheel
        // during the flight was silently ignored, pin/ratchet skipped, and
        // the climb then dragged the reader straight back down). Hand
        // everything back and let this event be processed like any scroll.
        const parked =
          pendingGlideRef.current &&
          scrollGlideRef.current === null &&
          Math.abs(el.scrollTop - parkedScrollTopRef.current) > 1;
        if (!parked) return;
        pendingGlideRef.current = false;
        glidingRef.current = false;
        jumpingRef.current = false;
        if (jumpTimerRef.current !== null) {
          window.clearTimeout(jumpTimerRef.current);
          jumpTimerRef.current = null;
        }
      }
      // Scrolling up SPENDS reserved room (turn-headroom.ts). Runs before
      // the pin test below and writes the spacer synchronously, so the
      // geometry that test reads is post-release: having eaten 100px of a
      // 500px blank leaves you at the new bottom, still pinned — not
      // "100px away from the bottom", which is what it would look like if
      // the two ran the other way round.
      if (!jumpingRef.current) ratchetHeadroomRef.current();
      // Any real scroll ends a synthetic (disclosure) unpin — geometry is
      // in charge again, and the chip may light on later growth.
      syntheticUnpinRef.current = false;
      const pinned =
        el.scrollTop + el.clientHeight >= el.scrollHeight - PIN_THRESHOLD_PX;
      pinnedRef.current = pinned;
      setPinnedState(pinned);
      if (pinned) {
        jumpingRef.current = false;
        setNewBelow(false);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // Your own actions (sending, entering a session, the jump chip) re-pin
  // explicitly — one helper so ref, state, and the chip stay in sync.
  const rePin = useCallback((): void => {
    pinnedRef.current = true;
    setPinnedState(true);
    setNewBelow(false);
    syntheticUnpinRef.current = false;
    // A send glide belongs to the turn that started it; anything that
    // re-pins (the next send, entering a session) ends it, or its handler
    // stand-down would outlive it and swallow the reader's own scrolling.
    // The CANCEL matters as much as the flag (review 2026-07-30): a damped
    // climb is a live rAF loop, and one left running would keep dragging
    // the scroller under the next send's parked flight.
    glidingRef.current = false;
    scrollGlideRef.current?.cancel();
    scrollGlideRef.current = null;
  }, []);
  // Expanding collapsed row content (a diff disclosure, an activity history)
  // unpins via context: the growth lands BELOW the toggle without any scroll
  // event, so `pinnedRef` would stay stale-true and the next follow trigger
  // (window resize, streamed block, status row) would yank the viewport to
  // the conversation's end, past the just-expanded content — the "expands
  // upward" read (user 2026-07-14). See ConversationPin.tsx.
  const unpin = useCallback((): void => {
    pinnedRef.current = false;
    setPinnedState(false);
    // Disclosure unpin, not a user scroll — suppress the jump chip until a
    // real scroll event hands control back to geometry (see syntheticUnpinRef).
    syntheticUnpinRef.current = true;
  }, []);
  // ── Turn headroom (2026-07-29) ─────────────────────────────────────────
  // A send that needs room fixes a target scrollable EXTENT; the spacer
  // below the flow is whatever is left of it, so "the bottom" is "your
  // message at the top of the pane" and a growing reply eats spacer instead
  // of moving anything. See turn-headroom.ts. Kept OUT of React state
  // deliberately — measured from layout and written back to layout at the
  // same moments the pinned follow already runs, and a state round-trip
  // would put a paint between the two.
  const headroomRef = useRef<HTMLDivElement>(null);
  /** The held extent, or null when nothing is reserved. Survives the turn
   *  that set it: a short answer leaves room still open, and the NEXT
   *  message lands in that room rather than scrolling to make more. */
  const headroomExtentRef = useRef<number | null>(null);
  /** The newest user row's offset from the top of the scrollable content. */
  const measureAnchorTop = useCallback((): number | null => {
    const el = scrollRef.current;
    if (el === null) return null;
    const rows = el.querySelectorAll<HTMLElement>(".user-row");
    const anchor = rows[rows.length - 1];
    if (anchor === undefined) return null;
    return (
      anchor.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop
    );
  }, []);
  /** The flow's height EXCLUDING the reservation, in `scrollHeight` units —
   *  what the spacer is sized against. Only ever read while an extent is
   *  held, which only happens on a pane the content fills, so the
   *  `scrollHeight >= clientHeight` clamp cannot distort it there. */
  const measureContentHeight = useCallback((): number => {
    const el = scrollRef.current;
    const spacer = headroomRef.current;
    if (el === null) return 0;
    return el.scrollHeight - (spacer?.offsetHeight ?? 0);
  }, []);
  /** The bottom of the real content, in the scroller's content coordinates.
   *  The spacer is the last thing in the flow, so its top edge IS that
   *  bottom — and unlike anything derived from `scrollHeight`, it stays
   *  honest on a conversation too short to fill the pane. */
  const measureContentBottom = useCallback((): number => {
    const el = scrollRef.current;
    const spacer = headroomRef.current;
    if (el === null || spacer === null) return 0;
    return (
      spacer.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop
    );
  }, []);
  /** Armed by the live-window trim just before it shrinks the record: the
   *  next sync slides the extent down instead of letting the trimmed rows'
   *  height reappear as blank (see the trim effect). */
  const headroomRebaseRef = useRef(false);
  /** Returns the height DELTA it wrote to the spacer (0 when nothing
   *  changed), so a caller that needs the post-sync bottom can derive it
   *  from geometry read BEFORE the write instead of re-reading after —
   *  the re-read forced a second layout on every reveal frame that was
   *  actively consuming the reservation (perf review 2026-07-31). */
  const syncHeadroom = useCallback((): number => {
    const spacer = headroomRef.current;
    if (spacer === null) return 0;
    let extent = headroomExtentRef.current;
    // Mirrored onto the node: the reservation is invisible by nature (it is
    // empty space), so "is it holding" is otherwise only answerable by
    // reading a ref in a debugger. Also what the wiring tests assert, since
    // jsdom has no layout and every measured height there is 0.
    spacer.dataset.armed = extent === null ? "false" : "true";
    if (extent === null) {
      // A stale rebase (extent released between arming and this sync) must
      // not survive to re-anchor some FUTURE reservation.
      headroomRebaseRef.current = false;
      if (spacer.style.height !== "0px") {
        // The previous write is the spacer's height — no layout read needed
        // (the spacer has no transition, by design).
        const prev = Number.parseInt(spacer.style.height, 10) || 0;
        spacer.style.height = "0px";
        return -prev;
      }
      return 0;
    }
    const current = spacer.offsetHeight;
    const contentHeight = measureContentHeight();
    // The extent is a content-coordinate total, and a trim removed content
    // ABOVE it — left as-is, headroomFor would hand the trimmed rows' height
    // to the spacer as fresh blank and the pinned view would park on empty
    // pane (review 2026-07-31). This first post-shrink sync sees the
    // shrunken content with the spacer still at its pre-trim size, so
    // content + current IS the slid-down extent that keeps the visible blank
    // exactly as it was.
    if (headroomRebaseRef.current) {
      headroomRebaseRef.current = false;
      extent = contentHeight + current;
      headroomExtentRef.current = extent;
    }
    const next = headroomFor({
      targetExtent: extent,
      contentHeight,
    });
    // Sub-pixel churn would write style on every reveal frame for nothing.
    if (Math.abs(next - current) >= 1) {
      spacer.style.height = `${next}px`;
      return next - current;
    }
    return 0;
  }, [measureContentHeight]);
  /** Spend reserved room as the reader scrolls up out of it. Cheap in the
   *  common case — once the extent is spent (null) or the reader is at the
   *  bottom, this is two property reads and a return, which is all it does
   *  for the whole life of a session that never scrolls back. Only the
   *  short phase of actively eating the blank pays for a layout. */
  const ratchetHeadroom = useCallback((): void => {
    const el = scrollRef.current;
    const extent = headroomExtentRef.current;
    if (el === null || extent === null) return;
    // At the bottom of the CURRENT layout, nothing is being spent — whatever
    // the stored extent says about where the bottom used to be. Room is spent
    // by scrolling UP out of it, and a view sitting at the bottom has not.
    //
    // This guard is the second half of the approval-panel drift (user
    // 2026-07-30). The panel's reserve going away SHRINKS the scroller under a
    // pinned view, so the browser clamps scrollTop down — a scroll event the
    // reader did not cause, arriving before the spacer has re-synced, so the
    // test below compared a fresh scroll position against a stale extent and
    // spent 200px of room the reader never left. Unrecoverable, too: a spent
    // reservation does not come back. Measured, both directions, in the
    // scratchpad approval-drift lab.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - PIN_THRESHOLD_PX)
      return;
    if (el.scrollTop + el.clientHeight >= extent) return;
    headroomExtentRef.current = releasedExtent({
      extent,
      scrollTop: el.scrollTop,
      viewport: el.clientHeight,
      contentHeight: measureContentHeight(),
    });
    syncHeadroom();
  }, [measureContentHeight, syncHeadroom]);
  ratchetHeadroomRef.current = ratchetHeadroom;
  const scrollToEndIfPinned = useCallback((): void => {
    // One forced layout per call (perf review 2026-07-31): while a reply is
    // eating the reservation, every reveal frame used to run read → spacer
    // write → scrollHeight RE-read, and the post-write re-read forced a
    // second layout each frame. Read the bottom first (this read after the
    // reveal's text commit is the one unavoidable layout), let the sync do
    // its clean-layout reads and its write, and derive the post-sync bottom
    // from the spacer delta. A scrollTop assignment past the real bottom is
    // clamped by the scroller, so the derivation needs no safety re-read.
    const el = scrollRef.current;
    const preBottom = el === null ? 0 : el.scrollHeight - el.clientHeight;
    const delta = syncHeadroom();
    // Only the SCROLL is suppressed mid-morph — a clone measured its landing
    // slot at flight start, and scrolling moves that slot; the settle
    // re-runs this. The SYNC deliberately runs THROUGH flights (deferred-fix
    // 2026-07-31): while a reservation holds, growth eats spacer and
    // scrollHeight stays constant — which is exactly what keeps the measured
    // slots still. Standing the sync down here (as it did until today) let
    // text streamed during the incoming clone's flight inflate the bottom
    // instead: the climb chased it past the anchored gap and snapped back at
    // the hand-off, and the incoming rise's owedScroll over-counted by the
    // same growth, aiming the clone a few lines too high. (With no
    // reservation armed the sync writes nothing, so this order is free.)
    if (morphInFlightRef.current) return;
    // While OUR climb runs, only the SCROLL stands down — the climb is the
    // follow, re-deriving the live bottom every frame, and an instant
    // scrollIntoView here would cut its damped tail short (the incoming
    // clone's settle lands exactly in this window). The sync above must keep
    // running: the spacer is what holds the extent as content grows, and a
    // stale spacer would feed the climb a bottom past the anchored position.
    if (glidingRef.current) return;
    if (pinnedRef.current && el !== null) {
      el.scrollTop = Math.max(0, preBottom + delta);
    }
  }, [syncHeadroom]);
  /** Take the scroller for a DAMPED climb to the bottom (scroll-glide.ts;
   *  user 2026-07-30 — the native smooth scroll spends a pane-sized move at
   *  constant speed and reads mechanical). The handler stands down
   *  (glidingRef) and the chip cannot light on growth that arrives before we
   *  land. No release timer: the glide retargets the live bottom every frame
   *  — the drift a timer existed to re-assert cannot accumulate — and its
   *  own lifecycle ends it (converged, runaway cap, wheel takeover). */
  const beginGlide = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    scrollGlideRef.current?.cancel();
    glidingRef.current = true;
    jumpingRef.current = true;
    if (jumpTimerRef.current !== null) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }
    const release = (reassert: boolean): void => {
      scrollGlideRef.current = null;
      jumpingRef.current = false;
      glidingRef.current = false;
      if (reassert) scrollToEndIfPinned();
    };
    scrollGlideRef.current = startScrollGlide(el, {
      // Converged at the live bottom — one exact re-assert (headroom sync +
      // pin) now that the catch-ups above stood down for the duration.
      onDone: () => release(true),
      // The reader took the wheel: geometry rules again, nothing re-asserted
      // — their very next scroll event runs the ratchet and the pin test.
      onUserTakeover: () => release(false),
    });
  }, [scrollToEndIfPinned]);
  /** The climb a send deferred until its bubble had landed (2026-07-30).
   *  Returns whether it took over, so the settle's catch-up can leave the
   *  scroller alone when it did. */
  const runPendingGlide = useCallback((): boolean => {
    if (!pendingGlideRef.current) return false;
    pendingGlideRef.current = false;
    // The spacer may have been resized while the flight was in the air (the
    // reply's first blocks land during it), so re-measure before travelling.
    syncHeadroom();
    beginGlide();
    return true;
  }, [beginGlide, syncHeadroom]);
  // Bug 2026-07-09 (sidebar-toggle vertical shift): the grid-column
  // animations (220ms sidebar collapse, 800ms connect rail slide) re-wrap
  // any bubble narrower than its fixed cap, changing heights ABOVE the
  // scroll position; with overflow-anchor:none the browser keeps scrollTop,
  // so the visible content slides up. Re-pin the bottom through container
  // resizes: a pinned view stays pinned frame-by-frame across the
  // transition; unpinned readers keep their scrollTop (no forced jump).
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      // Viewport-delta re-derive (deferred-fix 2026-07-31): an armed extent
      // baked in the send-time viewport — `anchorTop − GAP + viewport` — so
      // a maximize mid-hold left the anchored message viewport-delta below
      // its gap, and a restore-from-maximized could leave a spacer TALLER
      // than the pane (a wholly blank screen until the ratchet spent it).
      // Adding the height delta restores the contract at any size, and
      // because `maxScroll = extent − viewport` is invariant under it, the
      // pinned view doesn't move and no scroll correction is needed. Width
      // changes (sidebar toggle) deliberately don't touch the extent.
      const h = el.clientHeight;
      if (h !== lastHeight) {
        if (headroomExtentRef.current !== null) {
          headroomExtentRef.current += h - lastHeight;
        }
        lastHeight = h;
      }
      scrollToEndIfPinned();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToEndIfPinned]);
  morphInFlightRef.current = outgoingClone !== null || incomingClone;
  // Settle catch-up: growth frozen during the flight scrolls into view the
  // moment the last clone lands — or, when the send deferred its climb into the
  // reserved room, the OUTGOING landing is where that climb starts
  // (2026-07-30). Keyed on the clone unmounting rather than called from
  // onSettle, so the real bubble is already back on screen: the clone lives in
  // the overlay and does not scroll with the flow, so travelling before the
  // hand-off would carry the page out from under a message that was still a
  // clone.
  //
  // The climb waits for the OUTGOING clone only (review 2026-07-30). Gating it
  // on both let a fast first delta steal it: the incoming clone mounted during
  // the outgoing flight, the park's fallback timer outlived neither and
  // cleared the pending climb, and the eventual both-down catch-up landed the
  // page with an INSTANT snap — plus a hand-off mismatch, since the incoming
  // rise had aimed at the post-climb slot via owedScroll. Climbing under the
  // incoming flight is exactly what that compensation exists for.
  useEffect(() => {
    if (outgoingClone !== null) return;
    if (runPendingGlide()) return;
    if (!incomingClone) scrollToEndIfPinned();
  }, [outgoingClone, incomingClone, scrollToEndIfPinned, runPendingGlide]);

  // Rewind the latest 开拓者 turn: play a brief withdraw animation over the tail
  // rows (latest user row + everything below it), then ask the server to truncate
  // every record store. On success the reset event shrinks the record (the rows
  // unmount) and the withdrawn user text is staged back into the composer. The
  // animation is skipped under reduced motion (the truncation still happens).
  // Re-entry guard: the handler is async (220ms animation + IPC round-trip), so a
  // double-click could fire it twice and truncate two turns. One rewind at a time.
  const rewindingRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bridge/sessionStore/scrollRef are stable; `reduced`, `t`, and `lang` are the varying inputs
  const handleRewind = useCallback(async () => {
    if (rewindingRef.current) return;
    // Idle-only, checked HERE rather than by withholding the handler
    // (2026-07-30). The gate used to be a `canRewind` prop computed from
    // `status`, which put the turn's status in the row memo's dependencies and
    // re-rendered every row in the session on every send — for a control that
    // belongs to one row. Visibility is now CSS (`.conversation-flow.is-busy`)
    // and this is the actual guard: a live turn must not be truncated
    // underneath itself.
    if (sessionStore.getSnapshot().status !== "idle") return;
    rewindingRef.current = true;
    // Bind the destructive call to the session the user clicked in. The 220ms
    // animation below can race a sidebar session switch; both the renderer
    // check after the await AND main's sessionId match prevent the rewind
    // from truncating the newly-active session's turn.
    const clickedSessionId = sessionStore.getSnapshot().sessionId;
    let withdrawing: HTMLElement[] = [];
    try {
      if (clickedSessionId === null) return;
      const container = scrollRef.current;
      if (container !== null && !reduced) {
        const rows = Array.from(
          container.querySelectorAll<HTMLElement>(
            ".message-row, .activity-line-group",
          ),
        );
        let lastUserRow = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.classList.contains("user-row")) {
            lastUserRow = i;
            break;
          }
        }
        if (lastUserRow !== -1) {
          withdrawing = rows.slice(lastUserRow);
          for (const el of withdrawing) el.classList.add("is-withdrawing");
          await new Promise<void>((resolve) => setTimeout(resolve, 220));
        }
      }
      if (sessionStore.getSnapshot().sessionId !== clickedSessionId) {
        // Session switched during the animation — the rows we faded belong to
        // a record that is no longer on screen; nothing to truncate here.
        return;
      }
      const result = await bridge.rewindLastTurn(clickedSessionId);
      // Re-check AFTER the await too (audit 2026-07-10): main's sessionId
      // bind makes the truncation safe, but a session switch racing the
      // invoke reply could land the withdrawn text in the NEW session's
      // composer — the store now mirrors a different session. The rewind
      // itself succeeded; only the draft staging is session-bound.
      if (sessionStore.getSnapshot().sessionId !== clickedSessionId) {
        return;
      }
      if (result.ok) {
        // The record stores the wire token @板砖; an EN user typed/saw @Brick —
        // restore the draft in the form they sent (round-trip via the
        // composer's input alias, ADR 0015 §3).
        sessionStore.requestComposerDraft(
          dealiasBrickDraft(result.userText, lang),
          result.editedFiles ? t("workspace.editsNotReverted") : null,
        );
      } else {
        // Truncation didn't happen (e.g. a turn started in the gap) — un-fade the
        // rows so they don't hang in the withdrawn state. On success the rows
        // unmount with the reset, carrying the class away.
        for (const el of withdrawing) el.classList.remove("is-withdrawing");
      }
    } catch {
      // A REJECTED invoke (audit 2026-07-24, M3). The driver truncates the
      // JSONL durable-first and unguarded, so a filesystem failure (locked
      // file, full disk, read-only dir — plausible on Windows with AV or a
      // sync client) rejects here. Without this arm the tail rows kept
      // `.is-withdrawing`, whose animation ends at opacity 0 with
      // pointer-events:none — the turn stayed on screen as an invisible,
      // un-clickable gap, and only a session switch revealed it was never
      // withdrawn. React never rewrites these imperative classes (the rows
      // are memo'd), so nothing else could clean them up.
      for (const el of withdrawing) el.classList.remove("is-withdrawing");
      if (sessionStore.getSnapshot().sessionId === clickedSessionId) {
        // A silent failed rewind is indistinguishable from a no-op.
        sessionStore.requestComposerDraft(null, t("workspace.rewindFailed"));
      }
    } finally {
      rewindingRef.current = false;
    }
  }, [reduced, t, lang]);

  // Both in-flight indicators — the recap-compaction row and the galaxy-travel
  // row — share ONE gate so they appear at the same moment: only once the
  // send-morph has SETTLED (outgoingClone → null), never during the outgoing
  // bubble's flight (user 2026-06-20). Also suppressed once the backend (板砖)
  // owns the phase (a delegation turn stays "thinking" with no actor delta while
  // the backend works — its own 处理中…/activity indicator owns that window, user
  // 2026-06-16), a delta is already streaming, or the supervisor is judging a
  // candidate (the 伽马风暴 hold row owns that window). The recap leads while
  // compacting; otherwise the galaxy (chosen at render below).
  //
  // Gate on "turn in flight" (status !== "idle"), NOT status === "thinking"
  // (bug 3, 2026-07-09): after a @板砖 run's done-marker, the turn stays in
  // flight while Herta's synthesis completion generates — often the longest
  // silent wait of a delegation turn — but `status` is a STALE "speaking"
  // from the pre-dispatch speech, so the old gate showed nothing and the
  // user stared at a locked composer with no hint. Any non-idle status with
  // no live stream, no morph, and no backend activity is a genuine
  // waiting-on-Herta window; the appearance debounce below absorbs the
  // few-ms gaps at ordinary boundaries (speech committed → turn.finished).
  const inFlightSettled =
    status !== "idle" &&
    streamingText === null &&
    outgoingClone === null &&
    !backendActive &&
    !supervisorChecking;
  // Debounce the APPEARANCE (not the removal) by GALAXY_APPEAR_DELAY_MS so the
  // indicator never flickers in during the morph's final frames. The
  // recap↔galaxy swap stays immediate.
  const [showInFlight, setShowInFlight] = useState(false);
  /** When the row actually became visible — the clock the minimum-visible hold
   *  is measured from. Null whenever it is down. */
  const inFlightShownAtRef = useRef<number | null>(null);
  /** True while the row is being HELD past its hide condition, so a dispatch
   *  that lands fast cannot flash it (user 2026-07-30). Held only against the
   *  quiet hide reasons; `inFlightVisible` still drops it in the same render
   *  for a stream or a morph. */
  const [inFlightHeld, setInFlightHeld] = useState(false);
  /** True while the row is fading OUT after a quiet hide (user 2026-07-31:
   *  the swap to 处理中 was a hard same-commit switch). The row stays mounted
   *  without `is-shown` for IN_FLIGHT_EXIT_MS, then unmounts; 处理中 defers
   *  until the fade is done so the two hand off in place instead of stacking.
   *  Loud hides never enter this phase — see `inFlightVisible`. */
  const [inFlightExiting, setInFlightExiting] = useState(false);
  useEffect(() => {
    if (inFlightSettled) {
      setInFlightHeld(false);
      const id = window.setTimeout(() => {
        inFlightShownAtRef.current = Date.now();
        setInFlightExiting(false); // a re-show mid-fade resumes the row
        setShowInFlight(true);
      }, GALAXY_APPEAR_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    // The hide condition arrived before the row ever appeared — nothing to
    // fade, just disarm.
    const shownAt = inFlightShownAtRef.current;
    if (shownAt === null) {
      setInFlightHeld(false);
      setShowInFlight(false);
      return;
    }
    // The row is up. If it has not had its minimum time yet, hold it for the
    // remainder instead of yanking it; either way it leaves through the fade
    // (reduced motion skips the fade — there is no transition to play).
    const beginExit = (): void => {
      // A hold timer can outlive the row: this effect doesn't re-run on a
      // session switch (settled is false on both sides of the reset) or on a
      // loud hide, and both clear the shown clock. Pre-exit-fade the stale
      // fire only re-wrote false state; entering the fade here would render
      // a 220ms ghost row in whatever context came next.
      if (inFlightShownAtRef.current === null) return;
      inFlightShownAtRef.current = null;
      setInFlightHeld(false);
      setShowInFlight(false);
      if (!reduced) setInFlightExiting(true);
    };
    const remaining = IN_FLIGHT_MIN_VISIBLE_MS - (Date.now() - shownAt);
    if (remaining <= 0) {
      beginExit();
      return;
    }
    setInFlightHeld(true);
    const id = window.setTimeout(beginExit, remaining);
    return () => window.clearTimeout(id);
  }, [inFlightSettled, reduced]);
  // End of the exit fade → unmount. Keyed on the phase flag alone; a loud
  // event mid-fade clears the flag through the watcher below and this timer's
  // cleanup disarms it.
  useEffect(() => {
    if (!inFlightExiting) return;
    const id = window.setTimeout(
      () => setInFlightExiting(false),
      IN_FLIGHT_EXIT_MS,
    );
    return () => window.clearTimeout(id);
  }, [inFlightExiting]);
  // A loud hide — a stream, a morph, or the turn FAILING — ENDS the hold
  // rather than pausing it (user 2026-07-31). `inFlightVisible` below already
  // drops the row in the same render for a stream/morph, but the hold state
  // used to survive underneath: the moment the stream finished (dispatch
  // speech committed, bridge starting), the quiet branch turned true again
  // and the galaxy flashed BACK above the freshly mounted 处理中… row for the
  // rest of the minimum, shoving it down and back. A provider failure is loud
  // for the same reason (review 2026-07-31): its idle edge read as a quiet
  // hide, so the held galaxy sat stacked on TurnFailedRow — "crossing the
  // galaxy" directly above "the reply was lost" — then yanked it up mid-read.
  // (An interrupt sets no turnFailed and deliberately keeps the clean-finish
  // hold — indistinguishable at this level, and the same brief fade reads
  // fine.) Once the row is down, the run the hold was extending is over; the
  // next settled window re-shows through the normal appearance grace instead.
  useEffect(() => {
    if (streamingText === null && outgoingClone === null && !turnFailed) {
      return;
    }
    if (!showInFlight && !inFlightHeld && !inFlightExiting) return;
    inFlightShownAtRef.current = null;
    setInFlightHeld(false);
    setShowInFlight(false);
    setInFlightExiting(false);
  }, [
    streamingText,
    outgoingClone,
    turnFailed,
    showInFlight,
    inFlightHeld,
    inFlightExiting,
  ]);
  // The hold has no session identity (Class A, 2026-07-24 audit):
  // Conversation stays mounted across a switch, `inFlightSettled` is false on
  // both sides of the reset, and the loud watcher above sees only quiet in
  // the new session — so a hold armed by a fast turn-end rode into the next
  // session's entrance cascade for up to its remainder (review 2026-07-31).
  // The stale timer stays armed but only re-writes the same false state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    inFlightShownAtRef.current = null;
    setInFlightHeld(false);
    setShowInFlight(false);
    setInFlightExiting(false);
  }, [sessionId]);
  /**
   * Is an in-flight row on screen right now?
   *
   * `inFlightSettled ||` keeps the HIDE render-synchronous (bug 2026-07-10):
   * `showInFlight` is state cleared by an effect, one commit LATE, and in the
   * post-板砖 window the row is up when the first delta arrives — the
   * incoming-rise morph measured its landing slot while the row was still
   * mounted, then the row unmounted, the pinned scroll clamped ~a row-height,
   * and the clone landed overlapping the activity header before snapping down.
   *
   * The hold therefore stops at exactly that boundary: a stream or a morph
   * takes the row down in the same render regardless, and only the quieter
   * hide reasons (the backend starting, the turn ending) wait out the minimum.
   */
  const inFlightVisible =
    showInFlight &&
    (inFlightSettled ||
      (inFlightHeld && streamingText === null && outgoingClone === null));
  /** The exit fade, with the SAME render-synchronous loud-hide guard: a
   *  stream or a morph arriving mid-fade unmounts the row this render (the
   *  watcher then clears the stale flag), so the 2026-07-10 morph-measure
   *  invariant holds through the exit phase too. */
  const inFlightExitingVisible =
    inFlightExiting && streamingText === null && outgoingClone === null;
  /** Row mounted at all — visible or fading out. 处理中 defers on this, not
   *  on `inFlightVisible`, so it never mounts under a still-fading row. */
  const inFlightPresent = inFlightVisible || inFlightExitingVisible;

  // Supervisor judgment hint (bug 4, 2026-07-09; stall-gated 2026-07-10):
  // while the verdict is pending the paced reveal HOLDS its tail, so a slow
  // judgment reads as a frozen cursor. The row shows only when the judgment
  // is pending AND the visible reveal has actually STALLED — the supervisor
  // runs while the reveal is often still draining its backlog, and a moving
  // cursor needs no explanation. `lastGrowRef` is stamped by every reveal
  // growth frame (see onGrow below); a cheap poll compares it against the
  // stall window. Hiding is immediate on phase:end (verdict landed → the
  // reveal resumes or retracts).
  const lastGrowRef = useRef(0);
  const [showSupervisorHold, setShowSupervisorHold] = useState(false);
  useEffect(() => {
    if (!supervisorChecking) {
      setShowSupervisorHold(false);
      return;
    }
    // Start the stall clock at judgment start, not at the last pre-judgment
    // growth — the check often begins while the reveal is mid-drain.
    lastGrowRef.current = Date.now();
    const id = window.setInterval(() => {
      setShowSupervisorHold(
        Date.now() - lastGrowRef.current >= SUPERVISOR_HINT_DELAY_MS,
      );
    }, SUPERVISOR_HOLD_POLL_MS);
    return () => window.clearInterval(id);
  }, [supervisorChecking]);
  // The reveal's growth signal: stamps the stall clock, lights the jump chip
  // for an unpinned reader, then follows the pinned autoscroll (the original
  // onGrow behavior).
  const onRevealGrow = useCallback((): void => {
    lastGrowRef.current = Date.now();
    if (
      !pinnedRef.current &&
      !jumpingRef.current &&
      !syntheticUnpinRef.current
    ) {
      setNewBelow(true);
    }
    scrollToEndIfPinned();
  }, [scrollToEndIfPinned]);

  // Appended blocks light the chip the same way (record identity changes per
  // block, not per delta). Windowing (2026-07-12): compare ABSOLUTE end
  // indices so a "load earlier" PREPEND — which also changes record identity
  // while the reader is scrolled up — never lights the chip; only genuine
  // growth at the bottom does. A session switch re-baselines silently.
  const lastEndRef = useRef<{ sid: string | null; end: number }>({
    sid: null,
    end: 0,
  });
  useEffect(() => {
    const end = recordStart + record.length;
    const prev = lastEndRef.current;
    lastEndRef.current = { sid: sessionId, end };
    if (prev.sid !== sessionId) return; // new session — baseline only
    if (
      end > prev.end &&
      !pinnedRef.current &&
      !jumpingRef.current &&
      !syntheticUnpinRef.current
    ) {
      setNewBelow(true);
    }
  }, [record, recordStart, sessionId]);

  // The chip's click: glide back to the latest content. The scroll handler
  // re-pins when the glide lands at the bottom; `jumpingRef` keeps mid-glide
  // growth from re-lighting the chip, with a timeout fallback for a glide
  // interrupted by the user wheeling away.
  const jumpToLatest = useCallback((): void => {
    jumpingRef.current = true;
    setNewBelow(false);
    if (jumpTimerRef.current !== null)
      window.clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = window.setTimeout(() => {
      jumpTimerRef.current = null;
      jumpingRef.current = false;
    }, 1000);
    const el = scrollRef.current;
    if (el === null) return;
    // The TRUE bottom, for the same reason `scrollToBottom` exists: aligning
    // `endRef` leaves the approval reserve unscrolled, so with a gate open the
    // chip would land short of the bottom, leave the chip's own condition
    // still true, and spend reserved room on the way (2026-07-30). Smooth is
    // native here — this is a short hop the reader asked for, not the send's
    // page-sized climb (scroll-glide.ts).
    el.scrollTo({
      top: el.scrollHeight - el.clientHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [reduced]);
  useEffect(
    () => () => {
      if (jumpTimerRef.current !== null)
        window.clearTimeout(jumpTimerRef.current);
      if (jumpPollRef.current !== null)
        window.clearTimeout(jumpPollRef.current);
    },
    [],
  );
  // Presence-managed chip: the entrance transition arms one frame after
  // mount, and hiding (click, manual scroll-back, re-pin) plays the reverse
  // slide-fade before the unmount (user 2026-07-11 — it used to vanish with
  // no motion). 240ms exit ≥ the CSS's 200ms transition.
  const jumpChip = usePresence(!pinnedState && newBelow, 240);

  // ── Load-earlier paging (long sessions, 2026-07-12) ─────────────────────
  // The store holds only the trailing window; recordStart > 0 means older
  // blocks exist on the main side. Clicking pages them in; the viewport is
  // ANCHORED across the prepend (content grows ABOVE the scroll position and
  // overflow-anchor is disabled on the pane, so scrollTop must be offset by
  // the height delta manually or the visible content slides away).
  const prependAnchorRef = useRef<{
    /** The window start at click time — the offset applies only to the
     *  prepend this click caused (recordStart strictly decreases); any other
     *  window change (rewind/heal reset) clears the anchor instead. */
    expectFrom: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const loadEarlier = useCallback((): void => {
    const el = scrollRef.current;
    prependAnchorRef.current =
      el === null
        ? null
        : {
            expectFrom: sessionStore.getSnapshot().recordStart,
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          };
    // Reading older history: drop the pin so the append-follow effect can't
    // yank the view to the bottom when the prepend lands.
    pinnedRef.current = false;
    setPinnedState(false);
    void sessionStore.loadOlderBlocks();
  }, [sessionStore]);
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (anchor === null) return;
    prependAnchorRef.current = null;
    if (recordStart >= anchor.expectFrom) return; // not this click's prepend
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart]);

  // ── Topic-rail jump (2026-07-12) ─────────────────────────────────────────
  // Jump to a topic's anchoring user block. The anchor may be OLDER than the
  // loaded window — page history in first (bounded; bails if a fetch makes
  // no progress). Unpins up front so the prepends' append-follow effect can't
  // yank the view to the bottom mid-jump; the jump chip is the way back down.
  const jumpToTopic = useCallback(
    (anchorIndex: number): void => {
      void (async () => {
        // Session-bound (audit 2026-07-24, M4). Both halves below are async
        // continuations that re-read LIVE global state, so after a session
        // switch mid-jump they acted on the NEW session: the loop paged B's
        // history (visible jank on arrival) and the poll smooth-scrolled B to
        // an arbitrary older message, fighting the entrance effect that had
        // just pinned it. Captured identity + re-check after every await —
        // the pattern handleRewind already uses.
        const jumpSessionId = sessionStore.getSnapshot().sessionId;
        pinnedRef.current = false;
        setPinnedState(false);
        let guard = 0;
        while (
          sessionStore.getSnapshot().recordStart > anchorIndex &&
          guard < 60
        ) {
          guard += 1;
          const before = sessionStore.getSnapshot().recordStart;
          await sessionStore.loadOlderBlocks(
            Math.min(500, before - anchorIndex),
          );
          if (sessionStore.getSnapshot().sessionId !== jumpSessionId) return;
          if (sessionStore.getSnapshot().recordStart >= before) return; // no progress — bail
        }
        // Scroll once the anchor row exists: immediately when it is already
        // in the DOM (the common in-window case), else poll briefly for the
        // prepend's React commit. A TIMER, deliberately not rAF: rAF never
        // fires in a hidden/background window (found live in the website
        // demo pane, where a rAF-gated jump parked forever), while timers
        // run everywhere.
        const tryScroll = (attempt: number): void => {
          // The poll outlives the click: bail the moment the session changes,
          // and keep the handle so the session-entrance effect can cancel a
          // still-pending tick (M4 — it was previously stored nowhere, so
          // nothing could stop it).
          if (sessionStore.getSnapshot().sessionId !== jumpSessionId) return;
          const el = scrollRef.current?.querySelector(
            `[data-abs-index="${anchorIndex}"]`,
          );
          if (el !== null && el !== undefined) {
            el.scrollIntoView({
              block: "start",
              behavior: reduced ? "auto" : "smooth",
            });
            return;
          }
          if (attempt < 10) {
            jumpPollRef.current = window.setTimeout(
              () => tryScroll(attempt + 1),
              50,
            );
          }
        };
        tryScroll(0);
      })();
    },
    [sessionStore, reduced],
  );

  // Search-result landing (2026-07-27): a sidebar card that matched by CONTENT
  // asks, via the store, to land on the matched turn instead of the latest —
  // the search knew the moment and the open used to throw it away. Reuses the
  // topic jump wholesale: it already pages older blocks in, waits for the row
  // to commit, and bails on a session switch. Consumed once, then cleared, so
  // a later record change cannot re-fire it.
  useEffect(() => {
    // Only once the REQUESTED session is the one on screen: the request is
    // made before `openSession`, so consuming it unconditionally would fire
    // against the transcript still displayed and jump in the wrong session
    // (whose guard would then bail on the switch, landing nowhere).
    if (pendingJump === null || pendingJump.sessionId !== sessionId) return;
    sessionStore.clearPendingJump();
    jumpToTopic(pendingJump.blockIndex);
  }, [pendingJump, sessionId, sessionStore, jumpToTopic]);

  // Follow appended blocks / status rows while pinned. The per-frame reveal
  // growth is followed via StreamingReply's onGrow (this component no longer
  // re-renders per frame, so it can't watch the fill from here). EVERY
  // conditionally-mounted row below the flow needs its trigger here, or it
  // mounts below the fold on a full pane (user bug 2026-07-11: the 伽马风暴
  // hold row appeared behind the composer while the galaxy row — covered by
  // showInFlight — scrolled into view; the turn-failed row rides its
  // `status` → idle edge).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional scroll triggers, not effect inputs
  useEffect(() => {
    scrollToEndIfPinned();
  }, [
    record,
    pendingUser,
    status,
    showInFlight,
    // The held row leaves on its own timer, and its removal changes the flow's
    // height like any other row's — a pinned reader must follow that too.
    inFlightHeld,
    showSupervisorHold,
    backendActive,
    recapCompacting,
  ]);

  // Sending re-pins — but only for a reader who was already AT the bottom.
  // This fires on the commit BEFORE the morph clone mounts and measures, so
  // the slot rects the rise captures are post-scroll.
  //
  // It used to re-pin unconditionally ("your own send always lands you at the
  // bottom"), which yanked the pane out from under anyone reading history: type
  // a message while scrolled up in a long thread, press send, and the view
  // teleported to the end (user 2026-08-03). Sending is not a request to stop
  // reading. Scrolled up, the send now leaves the viewport exactly where it is
  // and lights the jump-to-bottom chip instead — the reader returns when they
  // choose to, and the chip is the affordance that already exists for it.
  useEffect(() => {
    if (pendingUser === null) return;
    // A DISCLOSURE unpin is not "reading history" (owner 2026-08-10). Opening
    // an activity history or a detail pane unpins on purpose — the follow must
    // not yank the viewport past what was just opened — but the reader is
    // still sitting at the bottom, and sending IS a request to see their own
    // message. Treated as scrolled-away it lost both halves of the send at
    // once: no flight (the clone declines to fly into a blind spot) and the
    // jump chip lit while the reader had never left. `syntheticUnpinRef` is
    // cleared by the first real scroll event, so a reader who expands and THEN
    // scrolls away is genuinely reading history and still gets the chip.
    if (!pinnedRef.current && !syntheticUnpinRef.current) {
      // Reading history. The message still lands in the flow below; the chip
      // says so. No re-pin, no headroom reservation (its measurements describe
      // an anchor that is off screen), no travel — and the detection effect
      // above has already declined to fly a clone into the same blind spot.
      setNewBelow(true);
      return;
    }
    rePin();
    // Fix the extent BEFORE the scroll, so "the end" is already the anchored
    // position when we land there — one scroll, not a jump followed by a
    // correction. The morph clone mounts on the next commit and measures a
    // slot that is final in both axes.
    //
    // The question is what the reader can SEE: is there already blank pane
    // under the conversation for this answer to land in? A short previous
    // answer leaves most of its reservation unused, and re-anchoring there
    // scrolled the thread up to make room that was already on screen (user
    // 2026-07-29). Holding the extent instead drops this message into that
    // blank without moving anything, and only re-fixes it once the answers
    // have actually eaten the room.
    //
    // LATCHED here, for this turn. Asked continuously, a growing reply would
    // cross the threshold mid-answer and reserve underneath it — a jump,
    // from a decision that belongs to the moment you pressed send.
    const el = scrollRef.current;
    const anchorTop = measureAnchorTop();
    const reserve =
      el !== null &&
      anchorTop !== null &&
      needsRoom({
        contentBottom: measureContentBottom(),
        maxScroll: el.scrollHeight - el.clientHeight,
        viewport: el.clientHeight,
      });
    if (reserve && el !== null && anchorTop !== null) {
      headroomExtentRef.current = targetExtentFor({
        anchorTop,
        viewport: el.clientHeight,
      });
    }
    syncHeadroom();
    // Making room moves the view a long way — most of a pane — so it GLIDES.
    // An instant landing reads as the page having been replaced rather than
    // scrolled (user 2026-07-29). Landing in room that already existed has
    // nothing to travel, and keeps the immediate landing it always had.
    const glide = reserve && !reduced;
    // ONE MOVE AT A TIME (user 2026-07-30). The climb and the bubble's flight
    // used to start together, so the page slid upward while the bubble was
    // still crossing it — two motions competing for the same eye, and the
    // flight had to aim at a slot that was moving. Sequenced: park at the
    // bottom of the REAL content, where the message lands flush against the
    // bottom edge with the reserved room still off screen, and hand the climb
    // to the flight's settle (see runPendingGlide).
    if (glide && el !== null && outgoingFlightArmedRef.current) {
      pendingGlideRef.current = true;
      // The scroller is OURS from here until the climb lands, and saying so
      // before parking is load-bearing: parking is a scroll AWAY from the
      // bottom, and the scroll handler's ratchet reads exactly that as the
      // reader stepping out of the reserved room and spends it (measured live
      // 2026-07-30 — the reservation evaporated on the park and the climb then
      // had 0px to travel). The fallback release covers a flight that never
      // settles; `beginGlide` replaces it with the real window when the climb
      // actually starts.
      glidingRef.current = true;
      jumpingRef.current = true;
      if (jumpTimerRef.current !== null) {
        window.clearTimeout(jumpTimerRef.current);
      }
      jumpTimerRef.current = window.setTimeout(() => {
        jumpTimerRef.current = null;
        jumpingRef.current = false;
        glidingRef.current = false;
        pendingGlideRef.current = false;
        scrollToEndIfPinned();
      }, OUTGOING_FLIGHT_MS + GLIDE_WINDOW_MS);
      el.scrollTop = preGlideScrollTop({
        contentBottom: measureContentBottom(),
        viewport: el.clientHeight,
      });
      // Record the parked position (post-assignment, so it carries the
      // browser's clamp): the scroll handler treats any OTHER position seen
      // during the park as the reader taking over.
      parkedScrollTopRef.current = el.scrollTop;
      return;
    }
    // Nothing is going to fly (no overlay/composer, or reduced motion), so
    // there is no settle to wait for: travel now, as it always did.
    if (glide) beginGlide();
    else scrollToBottom();
  }, [
    pendingUser,
    rePin,
    syncHeadroom,
    measureAnchorTop,
    measureContentBottom,
    reduced,
    beginGlide,
    scrollToEndIfPinned,
    scrollToBottom,
  ]);

  // Live-window trim (audit T3.5): live appends grow the windowed record
  // without bound — the 200-block tail bound (RECORD_TAIL_BLOCKS) applies
  // only to reset/open payloads — so a marathon sitting climbs mounted DOM
  // rows and per-commit reconcile cost forever. While the reader is PINNED
  // at the bottom, drop the window back to the tail bound once it runs 60
  // past it (hysteresis, not a per-block slice): the removed rows sit far
  // above the fold, the browser clamps scrollTop at the shrunken bottom
  // (still pinned), and "load earlier" pages them back on demand. Never
  // trims under an unpinned reader (they may be reading those rows) or
  // while a morph clone is measuring row slots (a shrinking flow would
  // move its landing slot — the same bug class the morphs just escaped).
  useEffect(() => {
    if (!pinnedRef.current || morphInFlightRef.current) return;
    if (record.length > 260) {
      // An armed reservation is a content-coordinate total; trimming rows
      // above it without sliding it down converts their height into spacer,
      // shoving the pinned view (streaming reply included) off the top
      // (review 2026-07-31). The height isn't knowable until the shrunken
      // flow lays out, so flag the next sync to rebase — the spacer keeps
      // its current size across the trim.
      if (headroomExtentRef.current !== null) {
        headroomRebaseRef.current = true;
      }
      sessionStore.trimRecordWindow(200);
    }
  }, [record, sessionStore]);

  // A tail-shrink of the record is a rewind: the reservation belonged to the
  // withdrawn turn, so it leaves with it (review 2026-07-31 — "the headroom
  // belongs to a turn YOU sent", and that turn is gone). Left armed, the
  // spacer grew by exactly the withdrawn rows' height and the pinned follow
  // parked the view on blank pane. Layout effect: the spacer must shrink in
  // the same commit the rows unmount, not a paint later. Session switches
  // also pass through here when the next session is shorter — harmless, the
  // entrance effect below releases the extent regardless.
  const prevRecordEndRef = useRef(0);
  useLayoutEffect(() => {
    const end = recordStart + record.length;
    const prev = prevRecordEndRef.current;
    prevRecordEndRef.current = end;
    if (end < prev) {
      // A rewind also invalidates a still-armed load-earlier anchor (review
      // 2026-07-31): its saved geometry predates the truncation, and it can
      // survive here when the reset happens not to move recordStart (the
      // anchor-consuming effect keys on that alone).
      prependAnchorRef.current = null;
      if (headroomExtentRef.current !== null) {
        headroomExtentRef.current = null;
        syncHeadroom();
      }
    }
  }, [record, recordStart, syncHeadroom]);

  // Session-scoped transients the entrance effect predates (review
  // 2026-07-31, Class A): `jumpingRef` is cleared only by a scroll that
  // lands pinned, so a switch mid-jump or mid-park left it latched in the
  // NEW session, silently suppressing the jump chip until the reader
  // touched bottom once; the park's fallback timer could fire its
  // scrollToEndIfPinned up to ~1.5s into the next session; and a
  // load-earlier anchor that survived a failed fetch would apply its saved
  // offset against another session's geometry entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    jumpingRef.current = false;
    if (jumpTimerRef.current !== null) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }
    prependAnchorRef.current = null;
  }, [sessionId]);

  // Session-switch stagger entrance (SPEC 2026-06-20-session-switch-transition).
  // On a genuine switch between two sessions, the newly-loaded conversation's
  // VISIBLE rows settle in with a staggered fade + upward drift; rows scrolled
  // out of view above just snap to their final state — no point animating unseen
  // content, and it keeps the cascade short on long threads. Runs on a switch
  // between sessions AND on entering one from the connect screen; skipped on a
  // blanking reset (→ no session), a same-session re-open, and reduced motion.
  // Imperative because it needs post-layout measurement of which rows
  // are visible; it doesn't fight React (the styles sit on record rows that have
  // no `style` prop, and self-clear once the cascade finishes).
  const prevSessionId = useRef<string | null>(null);
  const entranceTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const prev = prevSessionId.current;
    prevSessionId.current = sessionId;
    // Animate any change INTO a session — a switch between two sessions, OR
    // entering one from the connect screen (prev null → session). Skip a
    // blanking reset (→ no session) and a same-session re-open.
    if (sessionId === null || prev === sessionId) {
      // A blanking reset (current session deleted → connect page) still
      // clears the pin/chip state — Conversation stays mounted behind the
      // connect screen, so a live 回到底部 chip otherwise floats over it
      // (user bug 2026-07-24). No scroll or entrance cascade: there is no
      // session to land in.
      if (sessionId === null && prev !== null) {
        rePin();
        headroomExtentRef.current = null;
        pendingGlideRef.current = false;
        scrollGlideRef.current?.cancel();
        scrollGlideRef.current = null;
        syncHeadroom();
        if (jumpPollRef.current !== null) {
          window.clearTimeout(jumpPollRef.current);
          jumpPollRef.current = null;
        }
      }
      return;
    }
    // Any session change cancels a topic-jump poll left over from the one we
    // are leaving (audit 2026-07-24, M4).
    if (jumpPollRef.current !== null) {
      window.clearTimeout(jumpPollRef.current);
      jumpPollRef.current = null;
    }
    // Entering a session normally lands pinned at the bottom (even under
    // reduced motion, where the entrance cascade below is skipped) — UNLESS
    // it was opened from a search hit, which asked for a specific turn
    // (2026-07-27). Both used to run: this re-pinned and scrolled to the end
    // while the jump scrolled elsewhere from an async continuation, so the
    // landing came down to which won.
    //
    // The store read is reliable because the request is issued BEFORE
    // `openSession` (see SessionItem) and `onReset` preserves it — so by the
    // time this fires on the session change, the intent is already recorded.
    const jumpRequested =
      sessionStore.getSnapshot().pendingJump?.sessionId === sessionId;
    // The headroom belongs to a turn YOU sent, in the session you sent it
    // from. Arriving somewhere new lands at the real bottom, as it always
    // has — reserving space under someone else's last turn would read as a
    // rendering fault, not as room for an answer.
    headroomExtentRef.current = null;
    glidingRef.current = false;
    // A climb owed to a flight in the session we are LEAVING must not fire in
    // the one we are entering — the flight's clone unmounts on the switch, and
    // its settle effect would otherwise travel this session's scroller. A
    // climb already RUNNING is worse: flags alone don't stop its rAF loop.
    pendingGlideRef.current = false;
    scrollGlideRef.current?.cancel();
    scrollGlideRef.current = null;
    syncHeadroom();
    if (!jumpRequested) {
      rePin();
      scrollToBottom();
    }
    if (reduced) return;
    const container = scrollRef.current;
    if (container === null) return;
    const rowEls = Array.from(
      container.querySelectorAll<HTMLElement>(
        ".message-row, .activity-line-group",
      ),
    );
    if (rowEls.length === 0) return;
    if (entranceTimer.current !== null) {
      window.clearTimeout(entranceTimer.current);
      entranceTimer.current = null;
    }
    // Rows are reused across switches (keyed by index): clear any stale entrance
    // styles before measuring. The getBoundingClientRect reads below force the
    // reflow that lets re-applying the same keyframe restart cleanly.
    for (const el of rowEls) {
      el.style.animation = "";
      el.style.animationDelay = "";
    }
    const cr = container.getBoundingClientRect();
    const plan = planStaggerEntrance({
      rows: rowEls.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - cr.top, bottom: r.bottom - cr.top };
      }),
      viewport: { top: 0, bottom: cr.height },
      staggerMs: ENTRANCE_STAGGER_MS,
    });
    let maxDelay = 0;
    const animated: HTMLElement[] = [];
    plan.forEach((delay, idx) => {
      const el = rowEls[idx];
      if (el === undefined) return;
      el.style.animation = `conv-switch-in ${ENTRANCE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both`;
      el.style.animationDelay = `${delay}ms`;
      animated.push(el);
      if (delay > maxDelay) maxDelay = delay;
    });
    entranceTimer.current = window.setTimeout(
      () => {
        for (const el of animated) {
          el.style.animation = "";
          el.style.animationDelay = "";
        }
        entranceTimer.current = null;
      },
      ENTRANCE_DURATION_MS + maxDelay + 80,
    );
    return () => {
      if (entranceTimer.current !== null) {
        window.clearTimeout(entranceTimer.current);
        entranceTimer.current = null;
      }
    };
    // sessionStore is provider-stable; it is a dep only because the
    // stand-down check reads the pending jump straight off the snapshot.
  }, [sessionId, reduced, rePin, sessionStore, syncHeadroom, scrollToBottom]);

  // Memoized on record identity: the store mutates `record` only per BLOCK
  // (deltas accumulate in streamingText), so the grouping — O(n) over all
  // blocks — reruns per block, not per delta/frame.
  const items = useMemo(() => groupRecord(record), [record]);
  // The CURRENT dispatch's 任务清单, scanned across the WHOLE record — an
  // in-turn beat splits one backend run into several activity groups, and
  // each ActivityBlock sees only its own blocks, so the continuation group
  // has no todo projection of its own to read. Computed once here (O(n)
  // backward from the end, memoized on the record like `items`) and handed
  // ONLY to the group rendered as active, below.
  const plan = useMemo(() => planContext(record), [record]);
  // Attachment take-back (ADR 0033, owner 2026-08-10). Undefined while a turn
  // runs or with no session — the removal rides the same out-of-turn record
  // write as the attach, so an ✕ that could only earn a refusal is not shown
  // at all. A FACTORY per stored path so ActivityStep holds no record state;
  // memoized on the two things it closes over, keeping the rows memo stable
  // between turns.
  const removeAttachmentFactory = useMemo(() => {
    if (sessionId === null || status !== "idle") return undefined;
    return (path: string) => () => {
      void bridge
        .removeAttachment(sessionId, path)
        .then((r) => {
          if (!r.ok) {
            sessionStore.setComposerNotice(
              t("activity.attachment.removeFailed"),
            );
          }
        })
        .catch(() =>
          sessionStore.setComposerNotice(t("activity.attachment.removeFailed")),
        );
    };
  }, [sessionId, status, bridge, sessionStore, t]);
  // The rewind control shows only on the LATEST user turn, and only when idle
  // (no in-flight turn to race the truncation). Find the last `user` block index.
  const lastUserIndex = useMemo(() => {
    for (let i = record.length - 1; i >= 0; i--) {
      if (record[i]?.kind === "user") return i;
    }
    return -1;
  }, [record]);
  // ── the bubble rows ──────────────────────────────────────────────────────
  // Memoized on their REAL inputs (user profile 2026-07-12): per-frame state
  // flickers during the sidebar slide (pinned, fog edges) re-rendered
  // Conversation ~60×/s, and every render re-ran renderBlock — 240 × Intl date
  // formatting — measured as 119ms scripting per 210ms of animation plus an
  // 89ms long task on the toggle click itself.
  //
  // Split out from the activity rows (2026-07-30) so that "their real inputs"
  // is actually true. Sharing one memo with the activity groups meant sharing
  // their dependencies — status, turnStartedAt, backendStartedAt,
  // backendInFlight, backendActive, plan, canRewind — every one of which flips
  // at the moment of a send, so pressing send re-rendered every bubble in the
  // session, and again when the turn ended. None of them can change what a
  // bubble looks like. Now they cannot reach one: this memo survives a send,
  // the elements it holds stay referentially identical, and React skips those
  // subtrees outright.
  //
  // Aligned with `items` (activity slots hold null) so the assembly below can
  // index straight into it.
  const blockRows = useMemo(
    () =>
      items.map((item) =>
        item.kind === "block" ? (
          // Every row wrapped in a boundary (audit 2026-07-13 T2.2): a
          // render throw in one bubble is contained to that bubble. The
          // boundary renders its child directly (no wrapper DOM), so the
          // entrance-stagger child scan is unaffected.
          //
          // ABSOLUTE index as the key (windowing): a load-earlier
          // prepend shifts every relative index, which would remount
          // (and re-run entrance styles on) every existing row.
          <ErrorBoundary
            key={recordStart + item.index}
            label="record-row"
            fallback={<RowRenderError />}
          >
            {renderBlock(
              item.block,
              recordStart + item.index,
              now,
              locale,
              t,
              lang,
              // Handed over whenever this IS the latest user turn; whether a
              // rewind is allowed right now is no longer part of the row's
              // render (see handleRewind's own idle check, and the
              // `.is-busy` rule that hides the control mid-turn).
              item.index === lastUserIndex ? handleRewind : undefined,
            )}
          </ErrorBoundary>
        ) : null,
      ),
    [items, recordStart, now, locale, t, lang, lastUserIndex, handleRewind],
  );

  // ── assembly ────────────────────────────────────────────────────────────
  // Re-runs when the turn state moves, but only the activity groups are built
  // here; the bubble rows come from `blockRows` by reference.
  const rows = useMemo(
    () =>
      items.map((item, idx, all) => {
        if (item.kind === "block") return blockRows[idx];
        const isLast = idx === all.length - 1;
        // "Live" requires the CURRENT turn to actually own this group (audit
        // 2026-07-24, L1). The terminal-marker guard only recognizes 板砖's
        // done/noop markers, so an out-of-turn 系统 note (a workspace set /
        // reset) has none — and the moment the NEXT turn started, that
        // already-committed historical row began pulsing with a shimmering
        // header and a duration counting from 0s, as if 板砖 were performing
        // it right now. A backend anchor is the honest signal: it is null
        // until a dispatch actually starts, and the turn-start handler
        // clears it.
        const isActive =
          isLast &&
          status !== "idle" &&
          !activityHasTerminalMarker(item.blocks) &&
          (backendActive || backendStartedAt !== null);
        return (
          <ErrorBoundary
            key={`a${recordStart + item.startIndex}`}
            label="activity-row"
            fallback={<RowRenderError />}
          >
            <ActivityBlock
              blocks={item.blocks}
              active={isActive}
              // Live-turn state reaches only the live TURN's groups — every
              // group after the last user block, which includes the born-done
              // parts a beat split minted (they freeze their whole-run
              // duration from backendStartedAt while it is still set, so
              // strict `isActive` would starve them). Handed to every group,
              // the timestamps' null↔value flips at each turn boundary
              // defeated ActivityBlock's memo for the whole mounted history —
              // the last live-turn state still reaching historical rows after
              // adf67dc (perf review 2026-07-31).
              turnStartedAt={
                item.startIndex > lastUserIndex ? turnStartedAt : null
              }
              backendStartedAt={
                item.startIndex > lastUserIndex ? backendStartedAt : null
              }
              lang={lang}
              inFlightCount={isActive ? backendInFlight : 1}
              // Same discipline as inFlightCount: a historical group must
              // never receive live state. `plan` describes the dispatch in
              // flight, so a past group showing it would claim 板砖 is
              // working through a plan it finished turns ago.
              plan={isActive ? plan : null}
              onRemoveAttachment={removeAttachmentFactory}
            />
          </ErrorBoundary>
        );
      }),
    [
      items,
      blockRows,
      recordStart,
      lang,
      status,
      turnStartedAt,
      backendStartedAt,
      backendInFlight,
      plan,
      removeAttachmentFactory,
      // Read by the activity group's `isActive` (L1) — without it the rows
      // memo would keep rendering the last group as live after the backend
      // stopped.
      backendActive,
      // The live-turn gate above. Changes only with the record, which
      // already invalidates via `items` — listed for the lint contract.
      lastUserIndex,
    ],
  );
  // Mirrors TopicRail's own render guard: when the rail is up, the shell
  // reserves a left gutter so ticks never overlap content (activity LEDs)
  // on panes narrower than the flow's centered measure.
  const railVisible = topics.length >= 2;
  return (
    <ConversationPinProvider unpin={unpin}>
      <div
        className={`conversation-shell${railVisible ? " has-topic-rail" : ""}`}
      >
        <div
          className={`conversation${fog.top ? " has-fog-top" : ""}${
            fog.bottom ? " has-fog-bottom" : ""
          }`}
          ref={scrollRef}
        >
          {/* Centered readable column (user feedback 2026-07-06): with the left
            sidebar hidden the pane widens and fixed-width bubbles hugging the
            edges left the middle empty. The flow caps at a readable measure
            and centers; below the cap it is width-neutral. */}
          {/* `is-busy` hides the rewind control while a turn runs (the CSS
            rule, 2026-07-30). It used to be withheld as a prop, which put the
            turn's status inside the row memo and re-rendered every row in the
            session on send; a class on this one element costs nothing and the
            handler carries the real guard. */}
          <div
            ref={flowRef}
            className={`conversation-flow${status === "idle" ? "" : " is-busy"}`}
          >
            {/* Load-earlier paging: the window's start > 0 means older blocks
              exist main-side. In-flow (scrolls with the history it extends);
              the viewport is anchored across the prepend (see loadEarlier). */}
            {recordStart > 0 && (
              <button
                type="button"
                className="load-earlier"
                onClick={loadEarlier}
              >
                {t("workspace.loadEarlier", { n: recordStart })}
              </button>
            )}
            {/* Rows are keyed by record index, which COLLIDES across sessions —
            the panel stays mounted through a switch, so React would reuse row
            instances and leak per-row state (an ActivityBlock's expanded
            toggle / frozen duration from session A showing on session B's
            group at the same index). The session-keyed Fragment remounts the
            row set per session; within one session, indices are stable
            (append-only record). */}
            <Fragment key={sessionId ?? "none"}>{rows}</Fragment>
            {pendingUser !== null && (
              <UserBubble
                text={pendingUser}
                lang={lang}
                // Optimistic local echo of the just-sent message — its send time is
                // now, so it reads "just now". Once it lands in the record it carries
                // the stamped `at` (same minute), so the label stays stable.
                timestamp={formatBubbleTime(
                  new Date().toISOString(),
                  now,
                  locale,
                  t,
                )}
                hidden={hidePendingUser}
                bubbleRef={pendingUserBubbleRef}
              />
            )}
            {outgoingClone !== null && pendingUser !== null && (
              <MorphClone
                ref={cloneRef}
                overlay={overlayRef}
                variant="user"
                text={outgoingClone.text}
                lang={lang}
              />
            )}
            <StreamingReply
              lang={lang}
              streamingText={streamingText}
              retryText={retryText}
              retracting={retracting}
              retractKeepLen={retractKeepLen}
              reduced={reduced}
              hideStreaming={hideStreaming}
              showIncomingClone={incomingClone}
              streamingBubbleRef={streamingBubbleRef}
              incomingCloneRef={incomingCloneRef}
              overlayRef={overlayRef}
              onGrow={onRevealGrow}
            />

            {/* Supervisor judgment hold (bug 4): sits right under the held
            streaming bubble; mutually exclusive with the in-flight rows
            (inFlightSettled excludes supervisorChecking, and a live stream
            excludes the galaxy anyway). */}
            {showSupervisorHold && <SupervisorHoldRow />}
            {/* Both rows ride `inFlightPresent` — which carries the
            render-synchronous hide, the minimum-visible hold, AND the quiet
            exit fade; see the definitions for why those are one expression. */}
            {inFlightPresent && recapCompacting && (
              <RecapCompactRow exiting={inFlightExitingVisible} />
            )}
            {inFlightPresent && !recapCompacting && (
              <GalaxyTravelRow exiting={inFlightExitingVisible} />
            )}
            {/* Non-interrupt turn failure (slice 4): the reply was lost to a
            provider/connection error and nothing committed — say so instead
            of silently evaporating the half-typed sentence. */}
            {turnFailed && status === "idle" && (
              <TurnFailedRow
                status={turnFailedStatus}
                providerCode={turnFailedProviderCode}
              />
            )}
            {/* The 处理中… backend placeholder sits at the BOTTOM of the flow —
          backend work happens after Herta speaks the @板砖 delegation, so it
          must appear below her reply (record block or still-streaming bubble),
          never above it. Hidden once the real activity group is active. Also
          deferred while the in-flight row is still holding its minimum OR
          fading out — that row renders ABOVE this slot, so mounting under it
          shoved this row down and let it slide back up when the row left;
          instead the row leaves first (through its exit fade) and this one
          fades in where it stood (user 2026-07-31). */}
            {backendActive &&
              !inFlightPresent &&
              (() => {
                const last = items[items.length - 1];
                const lastIsActive =
                  last !== undefined &&
                  last.kind === "activity" &&
                  status !== "idle" &&
                  !activityHasTerminalMarker(last.blocks);
                return lastIsActive ? null : (
                  <PendingActivity
                    turnStartedAt={turnStartedAt}
                    backendStartedAt={backendStartedAt}
                    lang={lang}
                  />
                );
              })()}
            {/* Turn headroom: empty room reserved under the newest turn so
              the answer fills a region instead of crawling along the bottom
              edge. Height is written imperatively (turn-headroom.ts); it is
              0 until you send, and 0 again once a turn outgrows the pane. */}
            <div
              ref={headroomRef}
              className="turn-headroom"
              aria-hidden="true"
            />
            <div ref={endRef} aria-hidden="true" />
          </div>
        </div>
        {/* Jump-to-latest chip: new content arrived below a reader who scrolled
          up (pinned autoscroll correctly stays off; this is the one-click way
          back). Floats over the bottom fog; hidden the moment the reader is
          back at the bottom — by click or by scrolling there themselves. */}
        {/* Topic guide rail: one tick per topic on the left edge; hover swells
          the neighborhood + raises the topic card, click jumps (paging older
          history in if the anchor is outside the loaded window). Keyed by
          session so its transient state (fold expansion, hover) never leaks
          across a switch. */}
        <TopicRail
          key={sessionId ?? "none"}
          topics={topics}
          lang={lang}
          onJump={jumpToTopic}
          scrollerRef={scrollRef}
        />
        {jumpChip.mounted && (
          <button
            type="button"
            className={`jump-to-latest${jumpChip.open ? " is-open" : ""}`}
            onClick={jumpToLatest}
          >
            <span className="jump-to-latest__arrow" aria-hidden="true">
              ↓
            </span>
            {t("workspace.jumpToLatest")}
          </button>
        )}
      </div>
    </ConversationPinProvider>
  );
});
