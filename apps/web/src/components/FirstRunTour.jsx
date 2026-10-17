import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import ScratchExamples from "./ScratchExamples";
import { RING_PAD_PX, SpotlightRing, SpotlightVeil, ringFor, useTargetRect } from "./Spotlight";
import { hasOpenedScratch, markScratchOpened } from "../lib/scratchIntro";
import {
  TOUR_STEPS,
  advanceTour,
  endTour,
  onTourChange,
  readTourState,
  restartTour,
  shownStep,
} from "../lib/firstRunTour";

/**
 * FirstRunTour — the app's intro, the way a game opens: one screen at a time, in the
 * order the product wants a new person to meet it.
 *
 * A card names the step and offers exactly one obvious thing to do; skipping is always
 * available and nothing is forced. Anything the card cannot do from where it stands —
 * open the Add-goal dialog, take the user to Scratch — is handed to Coach, which owns
 * the screens.
 *
 * It is not a wall: every step it cannot point at (no goal yet, a target that never
 * arrives, a panel still loading) falls back to a centred card, and Back on Android ends
 * it for this load without touching the saved step, so it resumes next time.
 */

/** The phone's card sits above the bottom bar: the bar's height plus the home-indicator inset. */
const PHONE_BOTTOM = "calc(var(--gc-tab-bar-h) + var(--gc-nav-inset) + 0.75rem)";
/** Tailwind `sm` starts at 640, the same width the bottom bar and the top strip swap at. */
const PHONE_MAX_PX = 639;
/** A card never grows past the room it has, so its button stays reachable on a short screen. */
const CARD_MAX_H = "max-h-[calc(100dvh-2rem)] overflow-y-auto";
const CARD_MAX_H_PHONE = "max-h-[calc(100dvh-var(--gc-tab-bar-h)-var(--gc-nav-inset)-2rem)] overflow-y-auto";

/**
 * What each step points at, wherever this width draws it. A step absent from this map is
 * a centred card — there is nothing on screen to ring.
 */
const TARGETS = {
  timeline: ['[data-testid="calendar-sync-button"]'],
  today: ['[role="tablist"][aria-label="Range"]'],
  scratch_composer: ['[data-testid="scratch-composer"]'],
  // To-dos has no tab of its own on a phone: it lives behind the bar's "More".
  todos: ['[data-testid="mobile-tab-more"]', '[data-testid="panel-tab-todos"]'],
};

/** The screen a step needs under it. A step with no entry stays wherever the user already is. */
const PANEL_FOR_STEP = {
  goal: "state",
  timeline: "timeline",
  today: "today",
  scratch_composer: "scratch",
};

/** The card's words. One short title and at most a sentence or two — it sits over the app. */
const COPY = {
  signin: {
    title: "Sign in to keep your plan on every device",
    body: "You're previewing Sutra as a guest.",
    primary: "Sign in",
    secondary: "Continue as guest",
  },
  goal: {
    title: "Your first goal",
    body: "What do you want to get done?",
    primary: "Add a goal",
    secondary: "Skip",
  },
  timeline: {
    title: "Your plan, laid out in time",
    body: "Sync it to Google, Apple or Outlook calendar from here, on your phone too.",
    primary: "Next",
  },
  today: {
    title: "What's next",
    body: "Today, this week and this month.",
    primary: "Next",
  },
  scratch: {
    title: "Dump a thought in three seconds",
    body: "We work out what it is and file it.",
    primary: "Take me to Scratch",
  },
  scratch_composer: {
    title: "Meet Scratch",
    body: "Type or speak here.",
    primary: "Next",
  },
  todos: {
    title: "Your to-dos live here",
    body: "And on Today.",
    primary: "Done",
  },
};

/** The card. Centred or beside its target, the same box either way, with its own way out. */
function TourCard({ copy, children, onPrimary, onSecondary, onSkip, index, total, maxHeight }) {
  return (
    <div className={`pointer-events-auto relative w-full max-w-md rounded-2xl border border-[var(--accent)] bg-[var(--bg-secondary)] px-5 py-6 text-center shadow-xl ${maxHeight}`}>
      <h2 className="text-[20px] font-semibold text-[var(--text-primary)]">{copy.title}</h2>
      {copy.body && <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">{copy.body}</p>}
      {children && <div className="mt-4 text-left">{children}</div>}
      <button
        type="button"
        autoFocus
        onClick={onPrimary}
        data-testid="first-run-tour-primary"
        className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[16px] font-semibold text-white hover:opacity-90 focus:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_srgb,var(--accent)_40%,transparent)]"
      >
        {copy.primary}
        {copy.primary === "Take me to Scratch" && <ArrowRight className="h-5 w-5" aria-hidden="true" />}
      </button>
      {copy.secondary && (
        <button
          type="button"
          onClick={onSecondary}
          data-testid="first-run-tour-secondary"
          className="mt-3 min-h-11 w-full rounded text-[15px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {copy.secondary}
        </button>
      )}
      <button
        type="button"
        onClick={onSkip}
        data-testid="first-run-tour-skip"
        className="mt-2 min-h-11 rounded text-[14px] font-medium text-[var(--accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        Skip tour
      </button>
      <p className="sr-only">{`Step ${index + 1} of ${total}`}</p>
      <div aria-hidden="true" className="mt-3 flex justify-center gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i === index ? "h-1.5 w-5 rounded-full bg-[var(--accent)]" : "h-1.5 w-1.5 rounded-full bg-[var(--border-accent)]"} />
        ))}
      </div>
    </div>
  );
}

/**
 * Props, all supplied by Coach: `ready` (the board has loaded, so "is this an existing
 * user" can be answered), `goalCount`, `isGuest`, `goPanel`, `onOpenSignIn`,
 * `onOpenAddGoal`, `addGoalClosedAt` (changes when the Add-goal dialog closes) and
 * `onRunChange` (whether the tour currently has the floor).
 */
export default function FirstRunTour({
  ready = false,
  goalCount = 0,
  isGuest = false,
  goPanel = () => {},
  onOpenSignIn = () => {},
  onOpenAddGoal = () => {},
  addGoalClosedAt = 0,
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

  // The Add-goal dialog belongs to the Goal screen, so the tour hands off and waits rather than
  // drawing its own. It steps out of the way meanwhile — the dialog is the only thing to look at.
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const closedAtRef = useRef(addGoalClosedAt);

  useEffect(() => {
    onRunChange(running);
  }, [running, onRunChange]);

  const step = shownStep(store.step, isGuest);
  const stepKey = TOUR_STEPS[step]?.key;
  const selectors = TARGETS[stepKey] || null;
  const copy = COPY[stepKey];

  const advance = useCallback(() => {
    setGoalDialogOpen(false);
    advanceTour(step);
  }, [step]);

  const skip = useCallback(() => {
    setGoalDialogOpen(false);
    endTour();
  }, []);

  // Move to the screen this step lives on, once per step — never again, so a user who wanders off
  // is not yanked back.
  const navigatedRef = useRef(-1);
  useEffect(() => {
    if (!running) return;
    if (navigatedRef.current === step) return;
    navigatedRef.current = step;
    const panel = PANEL_FOR_STEP[stepKey];
    if (panel) goPanel(panel);
  }, [running, step, stepKey, goPanel]);

  useEffect(() => {
    if (!running) return undefined;
    const onPop = () => setStopped(true);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [running]);

  // The dialog has closed — with a goal or without one, that step is done.
  useEffect(() => {
    if (!goalDialogOpen || addGoalClosedAt === closedAtRef.current) return;
    advance();
  }, [goalDialogOpen, addGoalClosedAt, advance]);

  const openAddGoal = () => {
    closedAtRef.current = addGoalClosedAt;
    setGoalDialogOpen(true);
    onOpenAddGoal();
  };

  // Spot a target while the step is on screen. `useTargetRect` looks for about a second before giving
  // up, so a panel that is still loading ends as a centred card rather than a card pointing at nothing.
  const rect = useTargetRect(selectors, running && !goalDialogOpen);

  if (!running || !copy) return null;
  if (goalDialogOpen) return null;

  const ring = rect ? ringFor(rect) : null;
  const isPhone = window.innerWidth <= PHONE_MAX_PX;
  // A phone keeps the card clear of the bottom bar; a ringed step elsewhere sits above or below
  // whatever it points at, so it never covers it.
  const below = ring ? rect.top + rect.height / 2 < window.innerHeight / 2 : false;
  const anchored = isPhone && ring;

  const firstIndex = isGuest ? 0 : 1;
  const dotIndex = step - firstIndex;
  const dotTotal = TOUR_STEPS.length - firstIndex;

  const onPrimary = () => {
    if (stepKey === "signin") {
      onOpenSignIn();
      advance();
      return;
    }
    if (stepKey === "goal") {
      openAddGoal();
      return;
    }
    if (stepKey === "scratch") {
      markScratchOpened();
      goPanel("scratch");
      advance();
      return;
    }
    if (stepKey === "todos") {
      skip();
      return;
    }
    advance();
  };

  const card = (
    <TourCard
      copy={copy}
      onPrimary={onPrimary}
      onSecondary={advance}
      onSkip={skip}
      index={dotIndex}
      total={dotTotal}
      maxHeight={anchored ? CARD_MAX_H_PHONE : CARD_MAX_H}
    >
      {stepKey === "scratch" && <ScratchExamples />}
    </TourCard>
  );

  return (
    <div role="dialog" aria-modal="true" aria-label="How Sutra works" data-testid="first-run-tour" className="fixed inset-0 z-[55]">
      {/* The veil swallows taps, so the card is the only live thing. Nothing found to point at
          within the second we allow → no hole, and the card simply centres. */}
      <SpotlightVeil ring={ring} />
      {ring && <SpotlightRing ring={ring} label="Continue the tour" testId="first-run-tour-ring" onClick={advance} />}

      {anchored ? (
        <div className="pointer-events-none absolute inset-x-0 px-3" style={{ bottom: PHONE_BOTTOM }}>
          <div className="mx-auto max-w-md">{card}</div>
        </div>
      ) : ring ? (
        // Beside the target: centred across the window, clear of the target's own box.
        <div
          className="pointer-events-none absolute inset-x-0 flex justify-center px-5"
          style={below ? { top: rect.bottom + RING_PAD_PX } : { bottom: window.innerHeight - rect.top + RING_PAD_PX }}
        >
          {card}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-5">{card}</div>
      )}
    </div>
  );
}
