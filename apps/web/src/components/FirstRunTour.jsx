import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import ScratchExamples from "./ScratchExamples";
import { SpotlightRing, SpotlightVeil, ringFor, useTargetRect } from "./Spotlight";
import { hasOpenedScratch } from "../lib/scratchIntro";
import {
  TOUR_STEPS,
  advanceTour,
  arrivesAt,
  endTour,
  goToStep,
  nextNavStep,
  onTourChange,
  readTourState,
  restartTour,
  shownStep,
  stepOnJump,
} from "../lib/firstRunTour";

/**
 * FirstRunTour — a walkthrough the user drives themselves.
 *
 * The tour never navigates or opens anything for them. On a nav step it puts an arrow
 * on one navigation button and waits: the button stays tappable through the hole in the
 * veil, and the step ends when the app reaches that screen, however it got there. On a
 * screen step it points at one control on the screen the user is already on; if tapping
 * that control opens a dialog, the tour steps out of the way until the dialog closes and
 * then continues with the next step. Every step can be skipped, and the whole tour can
 * be ended from any one of them.
 *
 * The only exception is the sign-in offer, which stays a centred card: there is nothing
 * on screen to point at, and it is the one step that opens something itself.
 *
 * It is not a wall: a step whose target never arrives falls back to a centred card, and
 * Back on Android ends it for this load without touching the saved step, so it resumes
 * next time.
 */

/** Space between the card and the viewport edge. */
const GUTTER_PX = 16;
/** The caption card's width; it also never exceeds the viewport minus two gutters. */
const CARD_MAX_W_PX = 360;
/** The card's height before it has been measured — close enough to place the first frame. */
const CARD_ESTIMATE_H_PX = 200;
/** Room between the card and the ring for the bouncing arrow. */
const ARROW_SPACE_PX = 36;
/** The arrow glyph's box. */
const ARROW_ICON_PX = 24;
/** The label every step's way past itself carries, so no two steps word it differently. */
const SKIP_STEP = "Skip this step";

/**
 * What each step points at, wherever this width draws it. A nav step lists both the
 * phone's bottom-bar item and the desktop tab-strip item; whichever is hidden measures
 * zero, so the same list works on both. A step absent from this map is a centred card.
 */
const TARGETS = {
  goal_nav: ['[data-testid="mobile-tab-state"]', '[data-testid="panel-tab-state"]'],
  goal_screen: ['[data-testid="empty-state-add-goal"]', '[data-testid="add-goal-button"]'],
  timeline_nav: ['[data-testid="mobile-tab-timeline"]', '[data-testid="panel-tab-timeline"]'],
  timeline_screen: ['[data-testid="calendar-sync-button"]'],
  today_nav: ['[data-testid="mobile-tab-today"]', '[data-testid="panel-tab-today"]'],
  today_screen: ['[role="tablist"][aria-label="Range"]'],
  scratch_nav: ['[data-testid="mobile-tab-scratch"]', '[data-testid="panel-tab-scratch"]'],
  scratch_screen: ['[data-testid="scratch-composer"]'],
  // To-dos has no tab of its own on a phone: it lives behind the bar's "More".
  more_nav: ['[data-testid="mobile-tab-more"]', '[data-testid="panel-tab-todos"]'],
};

/**
 * The card's words. `emphasis` names the one word the card bolds — usually the button
 * the user is about to tap. Nav and screen steps carry a caption only; the dialog and
 * the composer carry a title too.
 *
 * Every step but the sign-in offer carries `secondary: SKIP_STEP`, so a step the user
 * does not want to act on is never a dead end. The sign-in offer is the exception
 * because it already has one: "Continue as guest" declines it and moves on.
 */
const COPY = {
  signin: {
    title: "Sign in to keep your plan on every device",
    body: "You're previewing Sutra as a guest.",
    primary: "Sign in",
    secondary: "Continue as guest",
  },
  goal_nav: { body: "Tap Goal to set what you're working towards.", emphasis: "Goal", secondary: SKIP_STEP },
  goal_screen: { body: "Add a goal, or skip and come back later.", secondary: SKIP_STEP },
  timeline_nav: {
    body: "Here's Timeline: your plan laid out in time.",
    emphasis: "Timeline",
    secondary: SKIP_STEP,
  },
  timeline_screen: {
    body: "Sync your plan to Google, Apple or Outlook calendar, on your phone too.",
    secondary: SKIP_STEP,
  },
  today_nav: { body: "Tap Today for what's next.", emphasis: "Today", secondary: SKIP_STEP },
  today_screen: { body: "Today, this week, this month.", secondary: SKIP_STEP },
  scratch_nav: {
    body: "Tap Scratch: the fastest way to get anything in.",
    emphasis: "Scratch",
    secondary: SKIP_STEP,
  },
  scratch_dialog: {
    title: "Meet Scratch",
    body: "A thought, a photo, a voice note. We work out what it is and file it.",
    primary: "Got it",
    secondary: SKIP_STEP,
  },
  scratch_screen: {
    title: "Your Scratch pad",
    body: "Type or speak here. We work out what it is and file it.",
    primary: "Next",
    secondary: SKIP_STEP,
  },
  more_nav: {
    body: "To-dos and everything else live under More.",
    emphasis: "More",
    primary: "Done",
    secondary: SKIP_STEP,
  },
};

/** Bold the one word a caption is pointing at, without splitting the sentence into HTML. */
function withEmphasis(text, word) {
  if (!word) return text;
  const at = text.indexOf(word);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-semibold text-[var(--text-primary)]">{word}</strong>
      {text.slice(at + word.length)}
    </>
  );
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * The caption card. Its own way out always, one obvious action when the step has one,
 * and the progress dots underneath — each of which jumps straight to its step.
 */
function TourCard({
  copy,
  children,
  onPrimary,
  onSecondary,
  onSkipTour,
  onGoTo,
  index,
  total,
  maxHeight,
  cardRef,
}) {
  return (
    <div
      ref={cardRef}
      data-testid="first-run-tour-card"
      className="w-full overflow-y-auto rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] px-5 py-5 text-center shadow-xl"
      style={maxHeight ? { maxHeight } : undefined}
    >
      {copy.title && <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">{copy.title}</h2>}
      {copy.body && (
        <p
          className={`${copy.title ? "mt-2" : ""} text-[16px] leading-relaxed text-[var(--text-secondary)]`}
        >
          {withEmphasis(copy.body, copy.emphasis)}
        </p>
      )}
      {children && <div className="mt-4 text-left">{children}</div>}
      {copy.primary && (
        <button
          type="button"
          autoFocus
          onClick={onPrimary}
          data-testid="first-run-tour-primary"
          className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[16px] font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
        >
          {copy.primary}
        </button>
      )}
      {copy.secondary && (
        <button
          type="button"
          autoFocus={!copy.primary}
          onClick={onSecondary}
          data-testid="first-run-tour-skip"
          className="mt-2 min-h-11 w-full rounded text-[15px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {copy.secondary}
        </button>
      )}
      {onSkipTour && (
        <button
          type="button"
          autoFocus={!copy.primary && !copy.secondary}
          onClick={onSkipTour}
          data-testid="first-run-tour-skip-tour"
          className="min-h-11 rounded px-2 text-[14px] font-medium text-[var(--accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          Skip tour
        </button>
      )}
      <p className="sr-only">{`Step ${index + 1} of ${total}`}</p>
      {/* Each dot is a button onto its own step. The button is the tap area and the dot is
          the mark inside it: 44px tall, and as wide as its share of the card, because one
          full 44px target per step is wider than the card the dots sit in. */}
      <div className="mt-3 flex">
        {Array.from({ length: total }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onGoTo(i)}
            aria-label={`Go to step ${i + 1} of ${total}`}
            aria-current={i === index ? "step" : undefined}
            data-testid="first-run-tour-dot"
            className="flex h-11 flex-1 items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <span
              aria-hidden="true"
              className={
                i === index
                  ? "h-1.5 w-5 rounded-full bg-[var(--accent)]"
                  : "h-1.5 w-1.5 rounded-full bg-[var(--border-accent)]"
              }
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Props, all supplied by Coach: `ready` (the board has loaded, so "is this an existing
 * user" can be answered), `goalCount`, `isGuest`, `panelView` (which screen is showing,
 * so a nav step knows when it has been reached), `dialogOpen` (any app dialog is open —
 * the tour hides while it is), `onOpenSignIn` and `onRunChange` (whether the tour
 * currently has the floor).
 */
export default function FirstRunTour({
  ready = false,
  goalCount = 0,
  isGuest = false,
  panelView = "",
  dialogOpen = false,
  onOpenSignIn = () => {},
  onRunChange = () => {},
}) {
  const [store, setStore] = useState(readTourState);
  useEffect(() => onTourChange(setStore), []);

  // Decided once, and only once the board is in: before that a goal-holder looks
  // identical to a brand-new user, and the tour must not start on someone who has one.
  const [decided, setDecided] = useState(false);
  useEffect(() => {
    if (decided || !ready) return;
    setDecided(true);
    // `?tour=1` replays the whole thing, for anyone who wants to see what a new user sees.
    if (new URLSearchParams(window.location.search).get("tour") === "1") {
      restartTour();
      return;
    }
    const saved = readTourState();
    if (saved.done) return;
    // A user who already has a goal and has been to Scratch is not a first-run user.
    if (goalCount > 0 && hasOpenedScratch()) endTour();
  }, [decided, ready, goalCount]);

  // Back on Android is "not now", not "never": this load only, so the next one resumes.
  const [stopped, setStopped] = useState(false);
  const running = decided && !store.done && !stopped;

  useEffect(() => {
    onRunChange(running);
  }, [running, onRunChange]);

  const step = shownStep(store.step, isGuest);
  const def = TOUR_STEPS[step];
  const stepKey = def?.key;
  const selectors = TARGETS[stepKey] || null;
  const copy = COPY[stepKey];

  const advance = useCallback(() => advanceTour(step), [step]);

  // A nav step ends when the app arrives at that screen — however it got there. If the
  // user is already standing on it when the step begins, it passes straight through to
  // the screen step that follows.
  const passedNavRef = useRef(-1);
  useEffect(() => {
    if (!running || def?.kind !== "nav") return;
    if (!arrivesAt(def, panelView) || passedNavRef.current === step) return;
    passedNavRef.current = step;
    advance();
  }, [running, def, panelView, step, advance]);

  // A dialog opened from the step's own control: hide until it closes, then continue
  // with the next step. Everything else about the tour waits too — the app has the floor.
  const dialogWasOpenRef = useRef(false);
  useEffect(() => {
    if (dialogOpen) {
      dialogWasOpenRef.current = true;
      return;
    }
    if (!dialogWasOpenRef.current) return;
    dialogWasOpenRef.current = false;
    if (running && def?.kind === "screen") advance();
  }, [dialogOpen, running, def, advance]);

  useEffect(() => {
    if (!running) return undefined;
    const onPop = () => setStopped(true);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [running]);

  // Spot a target while the step is on screen. `useTargetRect` looks for about a second
  // before giving up, so a panel that is still loading ends as a centred card.
  const rect = useTargetRect(selectors, running && !dialogOpen);

  // The card's real height drives the placement: above the target when it fits, below
  // otherwise, and never over the target itself.
  const [cardH, setCardH] = useState(CARD_ESTIMATE_H_PX);
  const cardRef = useRef(null);
  useLayoutEffect(() => {
    // `scrollHeight`, not `offsetHeight`: the card may currently be clamped by the room on
    // one side, and the natural height is what decides the side for the next step.
    const h = cardRef.current?.scrollHeight;
    if (h && Math.abs(h - cardH) > 1) setCardH(h);
    // Re-measure when the card's content changes, too — the component stays mounted across steps.
  }, [cardH, step]);

  if (!running || !copy || dialogOpen) return null;

  const ring = rect ? ringFor(rect) : null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(CARD_MAX_W_PX, vw - GUTTER_PX * 2);

  // Above or below the target, whichever has the room for the card and its arrow.
  let placement = "center";
  let top = 0;
  let maxHeight = null;
  if (ring) {
    const above = ring.y - GUTTER_PX - ARROW_SPACE_PX;
    const below = vh - (ring.y + ring.h) - GUTTER_PX - ARROW_SPACE_PX;
    if (above >= cardH) placement = "above";
    else if (below >= cardH) placement = "below";
    else placement = above >= below ? "above" : "below";
    const room = Math.max(0, placement === "above" ? above : below);
    // Never taller than the room on that side: the card scrolls rather than covering the target.
    const effectiveH = Math.min(cardH, room);
    top =
      placement === "above"
        ? ring.y - ARROW_SPACE_PX - effectiveH
        : ring.y + ring.h + ARROW_SPACE_PX;
    maxHeight = room;
  }
  const left = ring
    ? clamp(ring.x + ring.w / 2 - cardW / 2, GUTTER_PX, vw - GUTTER_PX - cardW)
    : GUTTER_PX;

  const arrowX = ring ? clamp(ring.x + ring.w / 2 - ARROW_ICON_PX / 2, GUTTER_PX, vw - GUTTER_PX - ARROW_ICON_PX) : 0;
  const arrowTop = ring
    ? placement === "above"
      ? ring.y - ARROW_SPACE_PX + 4
      : ring.y + ring.h + 4
    : 0;

  const firstIndex = isGuest ? 0 : 1;
  const dotIndex = step - firstIndex;
  const dotTotal = TOUR_STEPS.length - firstIndex;

  const onPrimary = () => {
    if (def.kind === "card") {
      onOpenSignIn();
      advance();
      return;
    }
    if (def.kind === "nav") {
      endTour();
      return;
    }
    advance();
  };

  // Skip this step: on a nav step it passes over this visit and the screen step after it,
  // landing on the next navigation button without the user going anywhere; on every other
  // step it simply moves on one. Screen steps keep Next as their primary button.
  const onSecondary =
    def.kind === "nav"
      ? () => {
          const next = nextNavStep(step);
          if (next < 0) endTour();
          else goToStep(next);
        }
      : advance;

  // A progress dot jumps straight to its step. `passedNavRef` is cleared first: coming back
  // to a nav step the user has already been through has to wait for its own tap again, or
  // the step would pass straight over the screen the user just asked to see.
  const onGoTo = (dot) => {
    passedNavRef.current = -1;
    goToStep(stepOnJump(dot + firstIndex, panelView));
  };

  const card = (
    <TourCard
      copy={copy}
      cardRef={cardRef}
      onPrimary={onPrimary}
      onSecondary={copy.secondary ? onSecondary : undefined}
      onSkipTour={endTour}
      onGoTo={onGoTo}
      index={dotIndex}
      total={dotTotal}
      maxHeight={maxHeight}
    >
      {def.kind === "dialog" && <ScratchExamples />}
    </TourCard>
  );

  // `aria-modal` is false on purpose: on a nav step the live control is the real button
  // under the hole, and a modal dialog would hide it from assistive technology.
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="How Sutra works"
      data-testid="first-run-tour"
      className="pointer-events-none fixed inset-0 z-[55]"
    >
      {/* Four panels, no overlay in the hole, and nothing else here that takes a pointer: the
          root is `pointer-events-none` precisely so the hole is a hole, and the panels and the
          card — the only things marked `pointer-events-auto` — are what still swallow taps. */}
      <SpotlightVeil ring={ring} />
      {ring && <SpotlightRing ring={ring} />}

      {ring && def.kind === "nav" && (
        <span
          aria-hidden="true"
          data-testid="first-run-tour-arrow"
          className="pointer-events-none absolute text-[var(--accent)] drop-shadow motion-safe:animate-bounce"
          style={{ left: arrowX, top: arrowTop, width: ARROW_ICON_PX, height: ARROW_ICON_PX }}
        >
          {placement === "above" ? <ArrowDown className="h-6 w-6" /> : <ArrowUp className="h-6 w-6" />}
        </span>
      )}

      {ring ? (
        <div
          className="pointer-events-none absolute"
          style={{ left, top, width: cardW }}
        >
          <div className="pointer-events-auto">{card}</div>
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
          <div className="pointer-events-auto w-full" style={{ maxWidth: cardW }}>
            {card}
          </div>
        </div>
      )}
    </div>
  );
}
