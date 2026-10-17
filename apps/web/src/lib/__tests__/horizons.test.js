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
