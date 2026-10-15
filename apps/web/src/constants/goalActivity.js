/** Wording for what a goal is busy doing. The server's own progress lines replace these as they arrive. */
export const ACTIVITY_PLANNING = "Calculating your timeline…";
export const ACTIVITY_REPLAN = "Re-planning around your change…";
export const ACTIVITY_TOAST_ID = "coach-activity";
export const ACTIVITY_TOAST_WORKING = (title, line) => `Coach is working on ${title || "your goal"}${line ? `: ${line}` : ""}`;
export const ACTIVITY_TOAST_MANY = (n) => `Coach is working on ${n} goals…`;
export const ACTIVITY_FALLBACK_TITLE = "your goals";
/** The key for work that touches every goal (a calendar change that may displace any of them). */
export const ACTIVITY_ALL_GOALS = "*";
/** Shown on a goal that has no schedule yet (the planner was interrupted), with the button that builds it. */
export const NO_SCHEDULE_TEXT = "No schedule yet — the coach hasn't placed this goal on your calendar.";
export const NO_SCHEDULE_BUTTON = "Build schedule";
