/**
 * Plain-language progress for the requests that take a while (the server places and re-places work
 * around the calendar before it answers). Each rule matches a request by method and path and lists
 * the steps shown in turn; the last step stays up until the request finishes.
 */

/** A request quicker than this shows nothing, so ordinary saves do not flash a toast. */
export const PROGRESS_SHOW_AFTER_MS = 1500;
/** How long each step stays up before the next one. */
export const PROGRESS_STEP_MS = 5000;

const PLAN_STEPS = [
  "Reading through your goal…",
  "Working out what needs to happen, and in what order…",
  "Finding free time in your week…",
  "Placing your sessions…",
  "Lining up your timeline…",
  "Almost there — a few finishing touches…",
];

const SCHEDULE_STEPS = [
  "Saving that…",
  "Checking what it changes in your week…",
  "Moving things around to fit…",
  "Updating your timeline…",
  "Almost done…",
];

const UPLOAD_STEPS = [
  "Uploading…",
  "Reading what's in it…",
  "Still reading — longer files take a little while…",
];

export const PROGRESS_RULES = [
  // An upload always shows its progress: the person is waiting on a file they chose.
  { methods: ["POST"], path: /^\/sources\/(upload|link)$/, steps: UPLOAD_STEPS, showAfterMs: 0 },
  { methods: ["POST"], path: /^\/plan\/change$/, steps: PLAN_STEPS },
  { methods: ["POST"], path: /^\/goals\/intake\/confirm$/, steps: PLAN_STEPS },
  { methods: ["POST", "PUT", "DELETE"], path: /^\/(timetable|blockers)(\/|$)/, steps: SCHEDULE_STEPS },
];

/** What a pending coach reply says before the server has sent its own progress line. */
export const PENDING_DEFAULT = "Reading what you wrote…";
/** After these delays the pending line adds reassurance, so a slow model never looks stuck. */
export const PENDING_REASSURANCE = [
  { afterMs: 12000, text: "Still on it — a good plan takes a moment." },
  { afterMs: 30000, text: "Nearly there. This one needs a bit more thought." },
];

/** What the Add Goal dialog says while it sets up a confirmed plan, in order. */
export const CONFIRM_STATUS = {
  saving: (done, total) => `Saving your goal and milestones (${done} of ${total})…`,
  placing: "Finding free time and placing your sessions in your week…",
  done: (title) => `All set — "${title}" is in your plan. The coach is keeping an eye on it and will adjust your week as things change.`,
};
/** How long the finished message stays up before the dialog closes itself. */
export const CLOSE_AFTER_CONFIRM_MS = 2800;
