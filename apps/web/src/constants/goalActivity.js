/** Wording for what a goal is busy doing. The server's own progress lines replace these as they arrive. */
export const ACTIVITY_PLANNING = "Calculating your timeline…";
export const ACTIVITY_REPLAN = "Re-planning around your change…";
export const ACTIVITY_TOAST_ID = "coach-activity";
export const ACTIVITY_TOAST_WORKING = (title, line) => `Coach is working on ${title || "your goal"}${line ? `: ${line}` : ""}`;
export const ACTIVITY_TOAST_MANY = (n) => `Coach is working on ${n} goals…`;
export const ACTIVITY_FALLBACK_TITLE = "your goals";
/** The key for work that touches every goal (a calendar change that may displace any of them). */
export const ACTIVITY_ALL_GOALS = "*";
/**
 * Shown on a goal whose schedule the server says is being built, even when this tab did not start it.
 * It replaces "No schedule yet" and the Build button, so a mid-build goal never offers a second build.
 */
export const BUILDING_SCHEDULE_TEXT = "Building your schedule…";
/** What a goal's slot in Today's target sections says while its plan is being written. */
export const BUILDING_PLAN_TEXT = "Building your plan…";
/** Shown on a goal that has no schedule yet (the planner was interrupted), with the button that builds it. */
export const NO_SCHEDULE_TEXT = "No schedule yet — the coach hasn't placed this goal on your calendar.";
export const NO_SCHEDULE_BUTTON = "Build schedule";
/** `goals.plan_status` values (sutra_api `PLAN_STATUSES`). */
export const PLAN_STATUS_PLANNING = "planning";
export const PLAN_STATUS_FAILED = "failed";
/** How often the goal list re-reads the board while a goal's schedule is being built elsewhere. */
export const PLAN_POLL_MS = 5000;
/**
 * A "planning" older than this is a run that died (the server's own limit is 300s), so the goal is treated
 * as unscheduled again. Generous on purpose: a live run must never be mistaken for a dead one.
 */
export const PLAN_LEASE_MS = 10 * 60 * 1000;
export const BUILD_FAILED_TOAST = (title) => `Couldn't build the schedule for ${title || "this goal"}. Try again from the goal.`;
