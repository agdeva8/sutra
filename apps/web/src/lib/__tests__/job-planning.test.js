import {
  failedJobForGoal,
  hasLiveJobs,
  isJobLive,
  jobsToActivity,
  liveJobForGoal,
  mergeActivity,
} from "../goalPlanning";
import { ACTIVITY_ALL_GOALS, ACTIVITY_REPLAN, JOB_DEFAULT_LINE } from "../../constants/goalActivity";

jest.mock("../api", () => ({ api: {}, STATE_STALE_EVENT: "sutra:state-stale" }));
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }));

const job = (over) => ({
  id: "job_1",
  kind: "build_plan",
  goal_id: "g1",
  goal_title: "Switch jobs",
  status: "running",
  progress: "",
  ...over,
});

test("queued and running jobs are live; finished ones are not", () => {
  expect(isJobLive(job({ status: "queued" }))).toBe(true);
  expect(isJobLive(job({ status: "running" }))).toBe(true);
  expect(isJobLive(job({ status: "done" }))).toBe(false);
  expect(isJobLive(job({ status: "failed" }))).toBe(false);
  expect(isJobLive(null)).toBe(false);
});

test("a goal's live job is found by goal id, ignoring other goals and finished work", () => {
  const state = {
    jobs: [
      job({ id: "a", goal_id: "g2", status: "running" }),
      job({ id: "b", goal_id: "g1", status: "queued" }),
      job({ id: "c", goal_id: "g1", status: "done" }),
    ],
  };
  expect(liveJobForGoal(state, "g1").id).toBe("b");
  expect(liveJobForGoal(state, "g3")).toBeNull();
  expect(liveJobForGoal(null, "g1")).toBeNull();
});

test("a failed goal job offers Retry only while it is the newest job for that goal", () => {
  // `/state.jobs` is newest-first; another goal's failure is irrelevant.
  expect(
    failedJobForGoal({ jobs: [job({ id: "b", status: "failed" }), job({ id: "c", goal_id: "g2", status: "failed" })] }, "g1").id,
  ).toBe("b");
  // A later run already fixed it, so the old failure must not keep offering Retry.
  expect(
    failedJobForGoal({ jobs: [job({ id: "a", status: "done" }), job({ id: "b", status: "failed" })] }, "g1"),
  ).toBeNull();
  expect(failedJobForGoal({ jobs: [] }, "g1")).toBeNull();
});

test("any queued or running job keeps the goal list polling", () => {
  expect(hasLiveJobs({ jobs: [job({ status: "queued" })] })).toBe(true);
  expect(hasLiveJobs({ jobs: [job({ status: "failed" })] })).toBe(false);
  expect(hasLiveJobs({})).toBe(false);
});

test("only running jobs become activity lines — queued is not work yet", () => {
  const items = jobsToActivity(
    [
      job({ id: "a", status: "queued" }),
      job({ id: "b", status: "running", progress: "Placing your sessions…" }),
      job({ id: "c", status: "done" }),
    ],
    [],
  );
  expect(items).toEqual([
    { goalId: "g1", title: "Switch jobs", line: "Placing your sessions…" },
  ]);
});

test("a job with no progress line falls back to a goal line, and a user-wide job reads as a re-plan", () => {
  const items = jobsToActivity(
    [
      job({ id: "a", goal_title: "", progress: "" }),
      job({ id: "b", kind: "replan_conflicts", goal_id: null, goal_title: "", progress: "" }),
    ],
    [{ id: "g1", title: "Find a flat" }],
  );
  expect(items).toEqual([
    { goalId: "g1", title: "Find a flat", line: JOB_DEFAULT_LINE },
    { goalId: ACTIVITY_ALL_GOALS, title: "your goals", line: ACTIVITY_REPLAN },
  ]);
});

test("this tab's own line wins for a goal the server is also reporting", () => {
  const local = [{ goalId: "g1", title: "Switch jobs", line: "Calculating your timeline…" }];
  const fromJobs = [
    { goalId: "g1", title: "Switch jobs", line: "Placing your sessions…" },
    { goalId: ACTIVITY_ALL_GOALS, title: "your goals", line: ACTIVITY_REPLAN },
  ];
  expect(mergeActivity(local, fromJobs)).toEqual([
    local[0],
    fromJobs[1],
  ]);
  expect(mergeActivity()).toEqual([]);
});
