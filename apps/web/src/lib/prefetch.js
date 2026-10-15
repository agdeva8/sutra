import { api } from "./api";

/**
 * A one-shot head start for the Scratch list.
 *
 * Scratch used to start its own GET only after its chunk loaded, which on a direct visit was after
 * `/api/state` had finished (a ~5s waterfall). The Coach page starts this at the same moment as the
 * state fetch; ScratchScreen takes the result instead of asking again, if it is still fresh.
 */
const FRESH_MS = 10000;
let pending = null;
let startedAt = 0;

export function prefetchScratch() {
  pending = api.scratch();
  pending.catch(() => {}); // the screen's own load reports failure; this one is only a head start
  startedAt = Date.now();
}

/** The prefetched list (once), or null when there is none or it has gone stale. */
export function takePrefetchedScratch() {
  const p = pending;
  pending = null;
  return p && Date.now() - startedAt < FRESH_MS ? p : null;
}
