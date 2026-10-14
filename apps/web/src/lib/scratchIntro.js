/**
 * Whether the user has opened Scratch yet, shared between the intro toast, the
 * Scratch tab's "new" dot and the explainer dialog.
 *
 * Stored in localStorage so it survives reloads, with an in-memory fallback for
 * private windows where storage throws. A tiny pub/sub lets the toast clear the
 * moment the tab is tapped, without prop-drilling.
 */
export const SCRATCH_OPENED_KEY = "sutra.scratchOpened";
const KEY = SCRATCH_OPENED_KEY;

let memory = false;
const listeners = new Set();

export function hasOpenedScratch() {
  try {
    return localStorage.getItem(KEY) === "1" || memory;
  } catch {
    return memory;
  }
}

export function markScratchOpened() {
  memory = true;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* storage blocked: the in-memory flag still holds for this session */
  }
  listeners.forEach((fn) => fn());
}

export function onScratchOpenedChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
