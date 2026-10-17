/**
 * The planner's new kinds of work on Today: quotas (a count per day), multi-day items (one item
 * across its days), and the outcomes a week/month plan row carries one per line.
 */
import { api } from "../api";
import { buildAgenda } from "../agenda";
import { isMultiDayBlock, isQuotaBlock } from "../events";
import { planOutcomes } from "../horizons";
import { adjustQuota, toggleDone } from "../todos";

jest.mock("../api", () => ({ api: { blocks: { update: jest.fn(() => Promise.resolve({})) } } }));

const KEYS = ["2026-10-14", "2026-10-15", "2026-10-16"];
// 2026-10-14 is a Wednesday: weekday 2, then 3 and 4.
const TODAY = new Date(2026, 9, 14, 12);
const GOALS = [{ id: "g", title: "Find a job", status: "active" }];

const quota = (over = {}) => ({
  id: "q1",
  block_kind: "task",
  title: "Send applications",
  goal_id: "g",
  day: "2026-10-14",
  placed_by: "planner",
  quota: 5,
  quota_done: {},
  repeat: { weekdays: [2, 3, 4], until: "2026-10-16" },
  effort_hours: 2.5,
  ...over,
});

const multiDay = (over = {}) => ({
  id: "m1",
  block_kind: "task",
  title: "Draft the report",
  goal_id: "g",
  day: "2026-10-14",
  placed_by: "planner",
  effort_hours: 4,
  repeat: { weekdays: [2, 3], until: "2026-10-15" },
  ...over,
});

const agenda = (blocks) => buildAgenda({ goals: GOALS, blocks }, KEYS, TODAY);

/** Apply one `onChange` updater to the board, the way Today's state does. */
const apply = (state, updater) => updater(state);

describe("quotas", () => {
  test("each day shows its own N/M, and only the day that reaches the quota is done", () => {
    const byDay = agenda([quota({ quota_done: { "2026-10-14": 3, "2026-10-15": 5 } })]);
    const [wed] = byDay["2026-10-14"];
    const [thu] = byDay["2026-10-15"];
    const [fri] = byDay["2026-10-16"];

    expect(wed).toMatchObject({ quota: 5, quotaDone: 3, done: false });
    expect(thu).toMatchObject({ quota: 5, quotaDone: 5, done: true });
    expect(fri).toMatchObject({ quota: 5, quotaDone: 0, done: false });
  });

  test("the block is recognised as a quota, not a multi-day item", () => {
    expect(isQuotaBlock(quota())).toBe(true);
    expect(isMultiDayBlock(quota())).toBe(false);
  });

  test("+1 writes this day's count through /blocks and patches the board in place", async () => {
    const block = quota({ quota_done: { "2026-10-14": 3 } });
    const state = { goals: GOALS, blocks: [block] };
    const onChange = jest.fn((updater) => apply(state, updater));

    await adjustQuota(block, "2026-10-14", 1, onChange);

    expect(api.blocks.update).toHaveBeenCalledWith("q1", {
      quota_done: { "2026-10-14": 4 },
    });
    const patched = onChange.mock.results[0].value;
    expect(patched.blocks[0].quota_done).toEqual({ "2026-10-14": 4 });
    // Other days are untouched.
    const [thu] = agenda(patched.blocks)["2026-10-15"];
    expect(thu).toMatchObject({ quotaDone: 0, done: false });
  });
});

describe("multi-day items", () => {
  test("one item appears on each of its days, numbered", () => {
    const byDay = agenda([multiDay()]);
    expect(byDay["2026-10-14"][0]).toMatchObject({ title: "Draft the report", dayIndex: 1, dayCount: 2, anytime: true });
    expect(byDay["2026-10-15"][0]).toMatchObject({ title: "Draft the report", dayIndex: 2, dayCount: 2 });
    expect(byDay["2026-10-16"]).toEqual([]);
    expect(isMultiDayBlock(multiDay())).toBe(true);
  });

  test("one tick ends it on all of its days", async () => {
    const block = multiDay();
    const state = { goals: GOALS, blocks: [block] };
    const onChange = jest.fn((updater) => apply(state, updater));

    await toggleDone(block, onChange);
    const patched = onChange.mock.results[0].value;

    expect(api.blocks.update).toHaveBeenCalledWith("m1", { done: true, state: "done" });
    const byDay = agenda(patched.blocks);
    expect(byDay["2026-10-14"][0].done).toBe(true);
    expect(byDay["2026-10-15"][0].done).toBe(true);
  });
});

describe("plan outcomes", () => {
  test("description is parsed one outcome per line, blank lines ignored", () => {
    expect(planOutcomes({ description: "Ship the draft\n\n  Review it  \n" })).toEqual([
      "Ship the draft",
      "Review it",
    ]);
  });

  test("a row without outcomes gives none", () => {
    expect(planOutcomes({})).toEqual([]);
    expect(planOutcomes({ description: "\n \n" })).toEqual([]);
  });
});
