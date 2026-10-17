/**
 * Where the first-run tour has got to, and whether it is over.
 *
 * The same shape as `lib/scratchIntro.js`: localStorage so the answer survives a
 * reload, an in-memory copy for the private windows and embedded webviews where
 * storage throws, and a tiny pub/sub so the tour can re-read without prop-drilling.
 *
 * What is stored is a step *index*, not a key — the tour is a sequence, and "pick up
 * where you left off" is the whole reason for storing anything at all.
 *
 * Each step carries its `kind`, which is how the tour knows what to do with it:
 *   - `card`   — a centred card with nothing on screen to point at (the sign-in offer).
 *   - `nav`    — an arrow at one navigation button, waiting for the user's own tap.
 *                `panel` (one screen) or `panels` (any of several) says which arrival
 *                counts as "done".
 *   - `screen` — an arrow at one control on the current screen, with Next.
 *   - `dialog` — a centred card that shows the Scratch examples before the composer.
 */

export const FIRST_RUN_TOUR_KEY = "sutra.firstRunTour";
const KEY = FIRST_RUN_TOUR_KEY;

/** Every screen the phone's "More" menu can land on. Any of them completes its step. */
export const MORE_PANELS = ["todos", "memories", "sources", "motivation", "plan", "home"];

/**
 * The steps, in order. `guestsOnly` is the one step a signed-in user never sees: the
 * app creates a guest session silently on first load, so the very first thing a new
 * person is offered is a way to keep what they are about to make.
 */
export const TOUR_STEPS = [
  { key: "signin", kind: "card", guestsOnly: true },
  { key: "goal_nav", kind: "nav", panel: "state" },
  { key: "goal_screen", kind: "screen" },
  { key: "timeline_nav", kind: "nav", panel: "timeline" },
  { key: "timeline_screen", kind: "screen" },
  { key: "today_nav", kind: "nav", panel: "today" },
  { key: "today_screen", kind: "screen" },
  { key: "scratch_nav", kind: "nav", panel: "scratch" },
  { key: "scratch_dialog", kind: "dialog" },
  { key: "scratch_screen", kind: "screen" },
  { key: "more_nav", kind: "nav", panels: MORE_PANELS },
];

/** The last step. Finishing it, or skipping anywhere, ends the tour. */
export const LAST_STEP = TOUR_STEPS.length - 1;

const START = { step: 0, done: false };

/** Written on every change; read back in its place when storage is unavailable. */
let memory = null;
const listeners = new Set();

/** A stored value from an older or hand-edited build, folded into something the tour can run. */
function normalise(value) {
  if (!value || typeof value.step !== "number" || !Number.isFinite(value.step)) return null;
  return { step: Math.min(Math.max(0, Math.floor(value.step)), LAST_STEP), done: Boolean(value.done) };
}

export function readTourState() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage blocked */
  }
  if (raw) {
    try {
      const parsed = normalise(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      /* unreadable: fall through to the in-memory copy */
    }
  }
  return memory ? { ...memory } : { ...START };
}

function write(next) {
  memory = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the in-memory copy still holds for this session */
  }
  listeners.forEach((fn) => fn(next));
}

/**
 * Move on one step; past the last one the tour is finished.
 *
 * Takes the step being *shown*, not the stored one: a signed-in user's first card is
 * step 1 while step 0 is still what is on disk, and advancing from the stored index
 * would leave them on the same card for ever.
 */
export function advanceTour(from) {
  if (from >= LAST_STEP) {
    endTour();
    return;
  }
  write({ step: from + 1, done: false });
}

/** Jump to a step by index — a nav step's Skip uses it to pass over the visit. */
export function goToStep(index) {
  if (index > LAST_STEP) {
    endTour();
    return;
  }
  write({ step: Math.max(0, Math.floor(index)), done: false });
}

/**
 * The next navigation step after `from`, or -1 when there is none. A nav step's Skip
 * jumps here: it passes over the visit (and the screen step that follows it) without
 * the user having to go anywhere.
 */
export function nextNavStep(from) {
  for (let i = from + 1; i < TOUR_STEPS.length; i += 1) {
    if (TOUR_STEPS[i].kind === "nav") return i;
  }
  return -1;
}

/**
 * The step to actually show. The sign-in step is for guests, so somebody who signed in
 * part-way through — or arrived already signed in — is not shown it again.
 */
export function shownStep(step, isGuest) {
  return !isGuest && step === 0 ? 1 : step;
}

/** Skip, or the last step's Done: the tour never shows itself again. */
export function endTour() {
  write({ step: LAST_STEP, done: true });
}

/** `?tour=1` — run it again from the top, for anyone who wants to see it as a new user does. */
export function restartTour() {
  write({ ...START });
}

export function onTourChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
