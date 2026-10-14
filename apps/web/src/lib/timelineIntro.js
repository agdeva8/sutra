/**
 * Whether the new user has been walked through their timeline yet: the second step of the first-run
 * guide (add a goal, see the timeline, then meet Scratch). Same shape as `scratchIntro`.
 */
export const TIMELINE_SEEN_KEY = "sutra.timelineSeen";

let memory = false;
const listeners = new Set();

export function hasSeenTimeline() {
  try {
    return localStorage.getItem(TIMELINE_SEEN_KEY) === "1" || memory;
  } catch {
    return memory;
  }
}

export function markTimelineSeen() {
  memory = true;
  try {
    localStorage.setItem(TIMELINE_SEEN_KEY, "1");
  } catch {
    /* storage blocked: the in-memory flag still holds for this session */
  }
  listeners.forEach((fn) => fn());
}

export function onTimelineSeenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
