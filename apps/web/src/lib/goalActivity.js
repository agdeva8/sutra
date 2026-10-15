import { useSyncExternalStore } from "react";
import { ACTIVITY_ALL_GOALS } from "../constants/goalActivity";

/**
 * What each goal is busy doing right now, so the goal card can say so ("Calculating your timeline…")
 * instead of sitting there looking finished while the plan underneath is being rewritten.
 *
 * Plain module state with subscribers: the work starts in `lib/api.js`, far from the card that shows it.
 * `ACTIVITY_ALL_GOALS` marks work that may touch any goal.
 */
const lines = new Map();
const listeners = new Set();
let snapshot = new Map();

const publish = () => {
  snapshot = new Map(lines); // a new Map each time, so subscribers see the change
  listeners.forEach((l) => l());
};

export function setGoalActivity(goalId, line, title) {
  if (!goalId) return;
  lines.set(goalId, { line, title: title ?? lines.get(goalId)?.title ?? "" });
  publish();
}

export function clearGoalActivity(goalId) {
  if (lines.delete(goalId)) publish();
}

/** Run `work`, showing `line` on the goal while it runs. `work` may call the returned `update(line)`. */
export async function trackGoalActivity(goalId, line, work, title) {
  setGoalActivity(goalId, line, title);
  try {
    return await work((next) => setGoalActivity(goalId, next));
  } finally {
    clearGoalActivity(goalId);
  }
}

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The line for this goal (its own, else the all-goals one), or null when it is idle. */
export default function useGoalActivity(goalId) {
  const map = useSyncExternalStore(subscribe, () => snapshot);
  return (map.get(goalId) || map.get(ACTIVITY_ALL_GOALS))?.line || null;
}

/** Everything the coach is busy with right now, as `[{ goalId, line, title }]`; empty when idle. */
export function useActivityList() {
  const map = useSyncExternalStore(subscribe, () => snapshot);
  return [...map.entries()].map(([goalId, v]) => ({ goalId, ...v }));
}
