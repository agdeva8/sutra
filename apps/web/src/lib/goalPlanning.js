import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, STATE_STALE_EVENT } from "./api";
import { clearGoalActivity, isGoalBusy, setGoalActivity } from "./goalActivity";
import {
  ACTIVITY_ALL_GOALS,
  ACTIVITY_FALLBACK_TITLE,
  ACTIVITY_PLANNING,
  ACTIVITY_REPLAN,
  BUILD_FAILED_TOAST,
  JOB_DEFAULT_LINE,
  JOB_STATUS_FAILED,
  JOB_STATUS_QUEUED,
  JOB_STATUS_RUNNING,
  PLAN_LEASE_MS,
  PLAN_POLL_MS,
  PLAN_STATUS_FAILED,
  PLAN_STATUS_PLANNING,
} from "../constants/goalActivity";

/**
 * Building a goal's schedule, owned by the app rather than by whichever dialog started it.
 *
 * The build runs for minutes. It used to live inside the Add Goal dialog, so closing the dialog, reloading
 * or switching screens left the goal with "No schedule yet" and a button. Now the build is a module-level
 * promise: the dialog only starts it, the goal card shows the coach working, and the board is re-read when
 * it ends. A goal another tab (or a reload) is building is read from the server's `plan_status` and polled.
 */

/** Goals this page has already started building, so a re-render never starts a second build. */
const started = new Set();

/** Start building `goal`'s schedule unless this page already is. Resolves when done; never rejects. */
export function buildSchedule(goal, { force = false } = {}) {
  if (!goal?.id || (!force && started.has(goal.id)) || isGoalBusy(goal.id)) return Promise.resolve();
  started.add(goal.id);
  return api
    .planGoal(goal.id, undefined, goal.title)
    .catch(() => toast.error(BUILD_FAILED_TOAST(goal.title)))
    .finally(() => window.dispatchEvent(new Event(STATE_STALE_EVENT)));
}

/**
 * Whether the server says a goal's schedule is being built right now, by this tab or another one.
 * The lease tells a live run from one that died mid-build (a run older than it is treated as over).
 */
export const planningIsLive = (g) =>
  g.plan_status === PLAN_STATUS_PLANNING && g.plan_started_at && Date.now() - Date.parse(g.plan_started_at) < PLAN_LEASE_MS;

/** True when the goal has no planned work yet (milestones alone are not a schedule). */
export const isUnscheduled = (state, goalId) =>
  !!state && !(state.plan_items || []).some((it) => it.goal_id === goalId && it.horizon !== "milestone");

/** Whether a background job still has work to do (queued or running). */
export const isJobLive = (job) =>
  job?.status === JOB_STATUS_QUEUED || job?.status === JOB_STATUS_RUNNING;

/** The newest live job for one goal, from `/state.jobs`; `null` when none is working on it. */
export const liveJobForGoal = (state, goalId) =>
  (state?.jobs || []).find((job) => isJobLive(job) && job.goal_id === goalId) || null;

/**
 * A goal-scoped job that failed and is waiting for a Retry, from `/state.jobs`.
 *
 * Only when it is the newest job for the goal: `/state.jobs` is newest-first, so a failure
 * that a later run already fixed stops offering Retry instead of outliving its cause.
 */
export const failedJobForGoal = (state, goalId) => {
  const newest = (state?.jobs || []).find((job) => job.goal_id === goalId);
  return newest?.status === JOB_STATUS_FAILED ? newest : null;
};

/** Whether any of the user's background jobs is still working — the list polls while one is. */
export const hasLiveJobs = (state) => (state?.jobs || []).some(isJobLive);

/**
 * The activity list the toast renders, in the shape `goalActivity` uses.
 *
 * `/state.jobs` is the server's view, so a job started in another tab (or before a reload) shows
 * too. A user-wide job keys on `ACTIVITY_ALL_GOALS`; a goal job uses its own title. Running only:
 * queued means "will run", and the toast should not claim work that has not started.
 */
export function jobsToActivity(jobs = [], goals = []) {
  const titles = new Map((goals || []).map((g) => [g.id, g.title]));
  return (jobs || [])
    .filter((job) => job.status === JOB_STATUS_RUNNING)
    .map((job) => ({
      goalId: job.goal_id || ACTIVITY_ALL_GOALS,
      title:
        job.goal_title ||
        titles.get(job.goal_id) ||
        (job.goal_id ? ACTIVITY_FALLBACK_TITLE : "your goals"),
      line: job.progress || (job.goal_id ? JOB_DEFAULT_LINE : ACTIVITY_REPLAN),
    }));
}

/**
 * The toast's list: this tab's own lines first (they update the moment a call starts), then the
 * server's running jobs for goals this tab is not already showing. One entry per goal either way.
 */
export function mergeActivity(local = [], fromJobs = []) {
  const seen = new Set(local.map((it) => it.goalId));
  return [...local, ...fromJobs.filter((it) => !seen.has(it.goalId))];
}

/**
 * Keep the goal list honest about schedules: poll while the server says a goal is being built somewhere
 * else, and start the build for an active goal that has none (unless its last build failed, which keeps
 * the button so a broken goal cannot loop).
 */
export function usePlanWatch(state, refresh) {
  const goals = state?.goals || [];
  const watched = useRef(new Set());

  const elsewhere = goals.filter((g) => g.status === "active" && planningIsLive(g) && !started.has(g.id));
  const key = elsewhere.map((g) => g.id).join(",");
  // A queued job is not a build yet, but it will become one within seconds; polling then keeps the
  // card's progress line current without the client having to know when the switch happened.
  const liveJobs = (state?.jobs || []).filter(isJobLive);
  const jobsKey = liveJobs.map((job) => job.id).join(",");

  useEffect(() => {
    const now = new Set(elsewhere.map((g) => g.id));
    // Show the coach working on goals being built elsewhere; stop when the server says it is over.
    elsewhere.forEach((g) => {
      if (!watched.current.has(g.id)) setGoalActivity(g.id, ACTIVITY_PLANNING, g.title);
    });
    watched.current.forEach((id) => {
      if (!now.has(id)) clearGoalActivity(id);
    });
    watched.current = now;
    if (now.size === 0 && !jobsKey) return undefined;
    const timer = setInterval(() => refresh?.(), PLAN_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, jobsKey]);

  useEffect(() => {
    if (!state) return;
    goals
      .filter((g) => g.status === "active" && isUnscheduled(state, g.id) && !planningIsLive(g) && g.plan_status !== PLAN_STATUS_FAILED)
      .forEach((g) => buildSchedule(g));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // The watcher's markers are its own; leave none behind when the list unmounts.
  useEffect(() => () => watched.current.forEach((id) => clearGoalActivity(id)), []);
}
