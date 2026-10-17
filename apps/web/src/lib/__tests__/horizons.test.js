import { monthTargetsFor, targetProgress, tasksInTarget, weekTargetsFor, weekTargetsInMonth } from "../horizons";

const goal = (id, extra = {}) => ({ id, title: `Goal ${id}`, status: "active", ...extra });
const weekly = (id, extra = {}) => ({
  id,
  horizon: "weekly",
  goal_id: "g",
  title: `Week ${id}`,
  start_date: "2026-10-12",
  end_date: "2026-10-18",
  weekly_hours: 5,
  ...extra,
});
const monthly = (id, extra = {}) => ({
  id,
  horizon: "monthly",
  goal_id: "g",
  title: `Month ${id}`,
  note: "20h",
  start_date: "2026-10-01",
  end_date: "2026-10-31",
  ...extra,
});
const daily = (id, extra = {}) => ({
  id,
  horizon: "daily",
  goal_id: "g",
  title: id,
  status: "open",
  due_date: "2026-10-14",
  note: "2h",
  ...extra,
});

describe("which target covers a date", () => {
  test("the week item whose dates contain the day, and none outside them", () => {
    const state = { goals: [goal("g")], plan_items: [weekly("w1")] };
    expect(weekTargetsFor(state, "2026-10-14").map((r) => r.item.id)).toEqual(["w1"]);
    expect(weekTargetsFor(state, "2026-10-19")).toEqual([]);
  });

  test("the month item covering the day", () => {
    const state = { goals: [goal("g")], plan_items: [monthly("m1")] };
    expect(monthTargetsFor(state, "2026-10-14").map((r) => r.item.id)).toEqual(["m1"]);
    expect(monthTargetsFor(state, "2026-11-02")).toEqual([]);
  });

  test("a Date and a day key read the same", () => {
    const state = { goals: [goal("g")], plan_items: [weekly("w1")] };
    expect(weekTargetsFor(state, new Date(2026, 9, 14, 12)).map((r) => r.item.id)).toEqual(["w1"]);
  });

  test("a dropped goal's targets are left out", () => {
    const state = {
      goals: [goal("g"), goal("d", { status: "dropped" })],
      plan_items: [weekly("w1"), weekly("w2", { goal_id: "d" })],
    };
    expect(weekTargetsFor(state, "2026-10-14").map((r) => r.item.id)).toEqual(["w1"]);
  });

  test("the weeks under a month are that goal's own, inside its dates, in order", () => {
    const state = {
      plan_items: [
        weekly("late", { start_date: "2026-10-26", end_date: "2026-11-01" }),
        weekly("early", { start_date: "2026-10-12", end_date: "2026-10-18" }),
        weekly("otherGoal", { goal_id: "x" }),
      ],
    };
    expect(weekTargetsInMonth(state, monthly("m1")).map((w) => w.id)).toEqual(["early", "late"]);
  });
});

describe("progress toward a target from the 4-kind board", () => {
  const block = (id, over = {}) => ({ id, block_kind: "task", goal_id: "g", title: id, day: "2026-10-14", placed_by: "planner", ...over });
  const state = {
    goals: [goal("g")],
    plan_items: [daily("twin", { due_date: "2026-10-15", note: "1h", status: "open" })],
    blocks: [
      block("planned", { title: "Planned", effort_hours: 2, done: true }),
      block("timed", { title: "Timed", day: "2026-10-15", start: "09:00", end: "10:30", placed_by: "user" }),
      // The user's own untimed item is a list entry, not planned work.
      block("loose", { title: "Loose", day: "2026-10-15", placed_by: "user" }),
      block("other", { title: "Other", goal_id: "x" }),
      block("outside", { title: "Outside", day: "2026-10-19" }),
      block("twin", { title: "Twin", day: "2026-10-15", state: "done" }),
    ],
  };

  test("a goal's planner-placed and timed task blocks count, mapped to the plan-row shape", () => {
    const rows = tasksInTarget(state, weekly("w1"));
    expect(rows.map((p) => p.id)).toEqual(["planned", "twin", "timed"]);
    expect(rows.find((p) => p.id === "timed")).toMatchObject({ status: "open", due_date: "2026-10-15", note: "1.5h" });
  });

  test("the hours and the done count come from the blocks too", () => {
    expect(targetProgress(state, weekly("w1"))).toEqual({
      done: 2,
      total: 3,
      doneHours: 3,
      plannedHours: 4.5,
      hasHours: true,
    });
  });

  test("a part-done block counts its fraction of the hours, not as a finished task", () => {
    const partial = { ...state, plan_items: [], blocks: [block("p", { effort_hours: 2, state: "partial", done_fraction: 0.5 })] };
    expect(targetProgress(partial, weekly("w1"))).toMatchObject({ done: 0, total: 1, doneHours: 1, plannedHours: 2 });
  });

  test("a block twin of a daily plan row is counted once, and either side being done marks it done", () => {
    const rows = tasksInTarget(state, weekly("w1")).filter((p) => p.id === "twin");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
  });
});

describe("progress toward a target", () => {
  test("counts its daily tasks done and total, and hours from the notes", () => {
    const state = {
      plan_items: [
        daily("a", { status: "done", note: "2h" }),
        daily("b", { note: "3h" }),
        daily("c", { status: "done", note: "1h", done_hours: 0.5 }),
      ],
    };
    expect(targetProgress(state, weekly("w1"))).toEqual({
      done: 2,
      total: 3,
      doneHours: 2.5,
      plannedHours: 6,
      hasHours: true,
    });
  });

  test("rows without hours report none", () => {
    const state = { plan_items: [daily("a", { note: "" }), daily("b", { note: "", status: "done" })] };
    expect(targetProgress(state, weekly("w1"))).toMatchObject({ done: 1, total: 2, plannedHours: 0, hasHours: false });
  });

  test("tasks outside the target's dates, other goals' tasks and to-dos are not counted", () => {
    const state = {
      plan_items: [
        daily("inside"),
        daily("before", { due_date: "2026-10-11" }),
        daily("after", { due_date: "2026-10-19" }),
        daily("otherGoal", { goal_id: "x" }),
        daily("todo", { item_type: "todo" }),
      ],
    };
    expect(tasksInTarget(state, weekly("w1")).map((p) => p.id)).toEqual(["inside"]);
  });
});
