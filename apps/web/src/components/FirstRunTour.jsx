import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import ScratchExamples from "./ScratchExamples";
import TourIllustration from "./tourIllustrations";
import { SpotlightRing, SpotlightVeil, ringFor, useTarget } from "./Spotlight";
import { hasOpenedScratch } from "../lib/scratchIntro";
import {
  LAST_STEP,
  TOUR_STEPS,
  advanceTour,
  arrivesAt,
  endTour,
  goToStep,
  nextStep,
  onTourChange,
  previousStep,
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
 * screen step it points at one control on the screen the user is already on; tapping that
 * control carries the tour forward, and a dialog it opens does the same when it closes.
 *
 * Every step can also be walked with the ‹ › zones down the card's edges, a sideways
 * swipe on the card, or a tap on one of the progress dots. The last step's Done ends it.
 *
 * The only exception to "point at something" is the sign-in offer, which stays a centred
 * card: there is nothing on screen to point at, and it is the one step that opens
 * something itself.
 *
 * It is not a wall: a step whose target never arrives falls back to a centred card, and
 * Back on Android ends it for this load without touching the saved step, so it resumes
 * next time.
 */

/** Space between the card and the viewport edge. */
const GUTTER_PX = 16;
/** The card's widest on a wide screen. On a phone it is the full width less two gutters. */
const CARD_MAX_W_PX = 360;
/** Below this width the app is the phone layout, and the card follows the phone rules. */
const PHONE_BREAKPOINT_PX = 640;
/** The card's height before it has been measured — close enough to place the first frame. */
const CARD_ESTIMATE_H_PX = 280;
/** Re-measure only when the height really changed, so the observer cannot spin. */
const CARD_MEASURE_EPSILON_PX = 1;
/** Room between the card and the ring for the bouncing arrow. */
const ARROW_SPACE_PX = 36;
/** The arrow glyph's box. */
const ARROW_ICON_PX = 24;
/** The gap between a bottom sheet and the tab bar it sits on. */
const SHEET_GAP_PX = 8;
/** The phone's bottom bar, measured so "is the target down there?" is a real answer. */
const TAB_BAR_SELECTOR = '[data-testid="mobile-tab-bar"]';
/** Fallback height of that bar when it cannot be measured (56px of tabs plus the safe-area inset). */
const TAB_BAR_ESTIMATE_H_PX = 80;
/** A drag this far sideways — and clearly more sideways than up or down — is a swipe, not a scroll. */
const SWIPE_MIN_PX = 40;

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
 * The card's words: one short line selling the feature, plus the button that moves past
 * the step. `emphasis` names the one word the line bolds — usually the control the user
 * is about to tap. The sign-in card is the only one with a second button, and the last
 * step is the only one whose primary ends the tour.
 */
const COPY = {
  signin: {
    line: "Your plan on every device, backed up.",
    primary: "Sign in",
    secondary: "Continue as guest",
  },
  goal_nav: {
    line: "Goal: say what you want, and the coach turns it into milestones.",
    emphasis: "Goal",
  },
  goal_screen: {
    line: "One sentence is enough. Add links, PDFs and photos to sharpen it.",
    primary: "Next",
  },
  timeline_nav: {
    line: "Timeline: your whole plan, laid out in time.",
    emphasis: "Timeline",
  },
  timeline_screen: {
    line: "It shows up in Google, Apple or Outlook calendar too.",
    primary: "Next",
  },
  today_nav: { line: "Today, this week, this month, at a glance.", emphasis: "Today" },
  today_screen: { line: "Zoom from today out to the month.", primary: "Next" },
  scratch_nav: { line: "Scratch: dump any thought in three seconds.", emphasis: "Scratch" },
  scratch_dialog: {
    title: "Meet Scratch",
    line: "A thought, a photo, a voice note. We file it.",
    primary: "Got it",
  },
  scratch_screen: { line: "Type, talk or snap a photo. We file it.", primary: "Next" },
  more_nav: { line: "More: to-dos and everything else live here.", emphasis: "More", primary: "Done" },
};

/** Bold the one word a line is pointing at, without splitting the sentence into HTML. */
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

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/**
 * One full-height tap zone down the card's edge. 44px wide, as tall as the card — the
 * same thumb-sized target the Meet Scratch carousel uses, so the two feel like one app.
 */
function ArrowZone({ direction, onClick, disabled, testId }) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === "prev" ? "Previous step" : "Next step"}
      data-testid={testId}
      className="flex w-11 shrink-0 items-center justify-center rounded-2xl text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="h-6 w-6" aria-hidden="true" />
    </button>
  );
}

/**
 * The caption card. An illustration and a line, then the step's own button. The arrows
 * are siblings of the content, not an overlay, so the text is never drawn under them and
 * each arrow gets the card's whole height to be tapped in. On the last step the right
 * zone is replaced by a spacer: there is no ›, but the content stays centred.
 */
function TourCard({
  copy,
  stepKey,
  children,
  onPrimary,
  onSecondary,
  onGoTo,
  onPrev,
  onNext,
  canPrev,
  canNext,
  index,
  total,
  maxHeight,
  cardRef,
  onTouchStart,
  onTouchEnd,
}) {
  return (
    <div
      ref={cardRef}
      data-testid="first-run-tour-card"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      className="w-full overflow-y-auto rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] text-center shadow-xl"
      style={maxHeight ? { maxHeight } : undefined}
    >
      <div className="flex items-stretch">
        <ArrowZone direction="prev" onClick={onPrev} disabled={!canPrev} testId="first-run-tour-prev" />
        <div className="min-w-0 flex-1 px-2 py-5">
          <TourIllustration stepKey={stepKey} />
          {copy.title && (
            <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">{copy.title}</h2>
          )}
          {copy.line && (
            <p
              className={`${copy.title ? "mt-1" : ""} text-[16px] leading-relaxed text-[var(--text-secondary)]`}
            >
              {withEmphasis(copy.line, copy.emphasis)}
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
              data-testid="first-run-tour-secondary"
              className="mt-2 min-h-11 w-full rounded text-[15px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {copy.secondary}
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
        {canNext ? (
          <ArrowZone direction="next" onClick={onNext} testId="first-run-tour-next" />
        ) : (
          <div aria-hidden="true" className="w-11 shrink-0" />
        )}
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

  // Re-measure once after each step's first paint: the first frame lands with the previous
  // step's geometry, which is exactly the placement bug being fixed here. The token is also
  // bumped whenever the target resizes, since a panel finishing its fetch moves it.
  const [paintTick, setPaintTick] = useState(0);
  const bumpPaintTick = useCallback(() => setPaintTick((t) => t + 1), []);
  useEffect(() => {
    if (!running) return undefined;
    const raf = requestAnimationFrame(bumpPaintTick);
    return () => cancelAnimationFrame(raf);
  }, [running, step, bumpPaintTick]);

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

  // Spot a target while the step is on screen. `useTarget` keeps looking for about a
  // second before giving up, so a panel that is still loading ends as a centred card.
  const { rect, el: targetEl } = useTarget(
    selectors,
    running && !dialogOpen && Boolean(selectors),
    paintTick
  );

  // The screen step's target: tapping it moves the tour on, exactly as the analogous nav
  // step does. A tap that opens a dialog is left to the effect above — this one waits a
  // tick, checks whether the app did open something, and only then advances.
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;
  const pendingTapRef = useRef(null);
  useEffect(() => {
    if (!running || dialogOpen || def?.kind !== "screen" || !targetEl) return undefined;
    const onClick = () => {
      clearTimeout(pendingTapRef.current);
      pendingTapRef.current = setTimeout(() => {
        if (!dialogOpenRef.current) advanceTour(step);
      }, 0);
    };
    targetEl.addEventListener("click", onClick);
    return () => targetEl.removeEventListener("click", onClick);
  }, [running, dialogOpen, def, targetEl, step]);
  useEffect(() => () => clearTimeout(pendingTapRef.current), []);

  useEffect(() => {
    if (!running) return undefined;
    const onPop = () => setStopped(true);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [running]);

  // The bottom bar's real height, so the sheet and the "is this target down there?" test
  // use the same number the layout does — including the safe-area inset and the font scale.
  const [tabBarH, setTabBarH] = useState(TAB_BAR_ESTIMATE_H_PX);
  useLayoutEffect(() => {
    if (!running) return undefined;
    const el = document.querySelector(TAB_BAR_SELECTOR);
    if (!el) return undefined;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setTabBarH((prev) => (Math.abs(prev - h) > CARD_MEASURE_EPSILON_PX ? h : prev));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [running]);

  // The card's natural height. `scrollHeight`, not `offsetHeight`: the card may currently
  // be clamped by the room on one side, and the natural height is what decides the side.
  const [cardH, setCardH] = useState(CARD_ESTIMATE_H_PX);
  const cardRef = useRef(null);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return undefined;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = el.scrollHeight;
        if (h && Math.abs(h - cardH) > CARD_MEASURE_EPSILON_PX) setCardH(h);
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(raf);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [cardH, step, running, dialogOpen]);

  // A target that changes size after it was found — a panel settling, a keyboard opening —
  // is a new measurement, not a new step.
  useLayoutEffect(() => {
    if (!targetEl || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(bumpPaintTick);
    observer.observe(targetEl);
    return () => observer.disconnect();
  }, [targetEl, bumpPaintTick]);

  // Everything below is geometry: no hooks past this point except the one scroll effect.
  const ring = rect ? ringFor(rect) : null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const phone = vw < PHONE_BREAKPOINT_PX;
  // The sheet is the full width less a gutter on each side; a wide screen keeps a card-sized card.
  const cardW = phone ? vw - GUTTER_PX * 2 : Math.min(CARD_MAX_W_PX, vw - GUTTER_PX * 2);
  // The bottom of the screen, where the tab bar lives. Measured, not guessed: a nav step's
  // target is inside the bar and must never be covered by the card. Its *centre* decides:
  // a tall control that merely reaches down to the bar is a sheet target, not a tab.
  const bottomZone = vh - tabBarH;
  const targetIsInBottom = Boolean(rect && rect.top + rect.height / 2 >= bottomZone);

  /**
   * Phone placement, in order of preference:
   *  1. A target in the bottom area (the tab bar) gets the card above it.
   *  2. Anything else gets a bottom sheet, full width less the gutter, sitting on the tab bar.
   *  3. With no target at all, the card is centred.
   * The card is never clipped: it lays out at its natural height and only scrolls if the
   * room on screen is smaller than the card itself. When the sheet would cover a target, the
   * target is scrolled into view first; if it is taller than the room above the sheet, the
   * sheet is allowed to overlap its lower part and the ring stays visible.
   */
  let placement = "center";
  let top = null;
  let bottom = null;
  let left = GUTTER_PX;
  let maxHeight = null;

  if (ring) {
    if (phone) {
      if (targetIsInBottom) {
        placement = "above";
        const room = ring.y - ARROW_SPACE_PX - GUTTER_PX;
        top = Math.max(GUTTER_PX, ring.y - ARROW_SPACE_PX - cardH);
        if (cardH > room) maxHeight = Math.max(0, room);
      } else {
        placement = "sheet";
        bottom = `calc(var(--gc-tab-bar-h) + var(--gc-nav-inset) + ${SHEET_GAP_PX}px)`;
        const room = vh - (tabBarH + SHEET_GAP_PX) - GUTTER_PX;
        if (cardH > room) maxHeight = Math.max(0, room);
      }
    } else {
      const above = ring.y - GUTTER_PX - ARROW_SPACE_PX;
      const below = vh - (ring.y + ring.h) - GUTTER_PX - ARROW_SPACE_PX;
      if (above >= cardH) placement = "above";
      else if (below >= cardH) placement = "below";
      else placement = above >= below ? "above" : "below";
      const room = Math.max(0, placement === "above" ? above : below);
      const effectiveH = Math.min(cardH, room);
      top = placement === "above" ? ring.y - ARROW_SPACE_PX - effectiveH : ring.y + ring.h + ARROW_SPACE_PX;
      maxHeight = cardH > room ? room : null;
      left = clamp(ring.x + ring.w / 2 - cardW / 2, GUTTER_PX, vw - GUTTER_PX - cardW);
    }
  } else {
    maxHeight = vh - GUTTER_PX * 2;
  }

  // Scroll the target above the sheet when the sheet would sit over it. Once per step:
  // after that the user's own scrolling is theirs, and the ring stays where they can see it.
  const scrolledForStepRef = useRef(-1);
  useLayoutEffect(() => {
    if (!running || dialogOpen || placement !== "sheet" || !targetEl) return undefined;
    if (scrolledForStepRef.current === step) return undefined;
    // After paint, so the card's real box — not its estimate — is what is compared.
    const raf = requestAnimationFrame(() => {
      const box = cardRef.current?.getBoundingClientRect();
      const target = targetEl.getBoundingClientRect();
      if (!box || box.top >= target.bottom) return;
      scrolledForStepRef.current = step;
      targetEl.scrollIntoView?.({
        block: "start",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [running, dialogOpen, placement, targetEl, step, cardH, rect]);

  // The start of a drag on the card, so the lift can tell a swipe from a scroll.
  const touchStart = useRef(null);

  if (!running || !copy || dialogOpen) return null;

  const arrowX = ring
    ? clamp(ring.x + ring.w / 2 - ARROW_ICON_PX / 2, GUTTER_PX, vw - GUTTER_PX - ARROW_ICON_PX)
    : 0;
  const arrowTop = ring
    ? placement === "above"
      ? ring.y - ARROW_SPACE_PX + 4
      : ring.y + ring.h + 4
    : 0;

  const firstIndex = isGuest ? 0 : 1;
  const dotIndex = step - firstIndex;
  const dotTotal = TOUR_STEPS.length - firstIndex;

  const prev = previousStep(step, isGuest);
  const next = nextStep(step);

  const onPrimary = () => {
    if (def.kind === "card") {
      onOpenSignIn();
      advance();
      return;
    }
    if (step === LAST_STEP) {
      endTour();
      return;
    }
    advance();
  };

  // "Continue as guest" is the sign-in card's only way past it that does not sign in.
  const onSecondary = advance;

  // A progress dot, an arrow or a swipe all jump by index. `passedNavRef` is cleared first:
  // coming back to a nav step the user has already been through has to wait for its own tap
  // again, or the step would pass straight over the screen the user just asked to see.
  const jumpTo = (index) => {
    if (index < 0) return;
    passedNavRef.current = -1;
    goToStep(index);
  };
  const onGoTo = (dot) => jumpTo(stepOnJump(dot + firstIndex, panelView));

  // A sideways swipe on the card does what the arrows do. Vertical drags are left alone:
  // that is the card scrolling, not navigation.
  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e) => {
    const from = touchStart.current;
    touchStart.current = null;
    const t = e.changedTouches[0];
    if (!from || !t) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
    jumpTo(dx < 0 ? next : prev);
  };

  const card = (
    <TourCard
      copy={copy}
      stepKey={stepKey}
      cardRef={cardRef}
      onPrimary={onPrimary}
      onSecondary={copy.secondary ? onSecondary : undefined}
      onGoTo={onGoTo}
      onPrev={() => jumpTo(prev)}
      onNext={() => jumpTo(next)}
      canPrev={prev >= 0}
      canNext={next >= 0}
      index={dotIndex}
      total={dotTotal}
      maxHeight={maxHeight}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {def.kind === "dialog" && <ScratchExamples />}
    </TourCard>
  );

  const cardBoxStyle = { left, width: cardW };
  if (bottom) cardBoxStyle.bottom = bottom;
  else if (top != null) cardBoxStyle.top = top;

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
        <div className="pointer-events-none absolute" style={cardBoxStyle}>
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
