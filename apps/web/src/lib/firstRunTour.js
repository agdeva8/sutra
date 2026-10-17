/**
 * Where the first-run tour has got to, and whether it is over.
 *
 * The same shape as `lib/scratchIntro.js`: localStorage so the answer survives a
 * reload, an in-memory copy for the private windows and embedded webviews where
 * storage throws, and a tiny pub/sub so the tour can re-read without prop-drilling.
 *
 * What is stored is a step *index*, not a key — the tour is a sequence, and "pick up
 * where you left off" is the whole reason for storing anything at all.
 */
export const FIRST_RUN_TOUR_KEY = "sutra.firstRunTour";
const KEY = FIRST_RUN_TOUR_KEY;

/**
 * The steps, in order. `guestsOnly` is the one step a signed-in user never sees: the
 * app creates a guest session silently on first load, so the very first thing a new
 * person is offered is a way to keep what they are about to make.
 */
export const TOUR_STEPS = [
  { key: "signin", guestsOnly: true },
  { key: "goal" },
  { key: "timeline" },
  { key: "today" },
  { key: "scratch" },
  { key: "scratch_composer" },
  { key: "todos" },
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
