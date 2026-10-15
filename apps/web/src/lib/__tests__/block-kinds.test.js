import { blockEvent, taskEvent, EVENT_KIND } from "../events";
import { KIND_STYLE, goalColor } from "../../constants/calendarKinds";

const block = (over) => ({ id: "b", label: "x", block_date: "2026-10-15", start_time: "09:00", end_time: "10:00", kind: "tentative", source: "agent", ...over });

test("a block with a goal is a goal session in the goal's colour, whatever its kind", () => {
  for (const kind of ["tentative", "commitment"]) {
    const e = blockEvent(block({ kind, goal_id: "g1" }));
    expect(e.kind).toBe(EVENT_KIND.session);
    expect(e.color).toBe(goalColor("g1"));
  }
});

test("a block with no goal is a commitment, including focus and the API's commitment kind", () => {
  for (const kind of ["commitment", "focus", "tentative"]) {
    const e = blockEvent(block({ kind, goal_id: null }));
    expect(e.kind).toBe(EVENT_KIND.commitment);
    expect(e.color).toBe(KIND_STYLE.fixed.color);
  }
});

test("a slot for a goal-less task is a commitment that still ticks the task", () => {
  const task = { id: "t1", status: "done" };
  const e = blockEvent(block({ goal_id: null, source_id: "t1" }), { taskById: new Map([["t1", task]]) });
  expect(e.kind).toBe(EVENT_KIND.commitment);
  expect(e.task).toBe(task);
  expect(e.done).toBe(true);
});

test("reminders and repeats listed among blocks keep their own kind", () => {
  expect(blockEvent(block({ kind: "reminder", goal_id: "g1", source_id: "r1" })).kind).toBe(EVENT_KIND.reminder);
  expect(blockEvent(block({ kind: "commitment", source: "recurring", source_id: "s1" })).kind).toBe(EVENT_KIND.recurring);
});

test("a task with no goal draws as a commitment but stays a task", () => {
  const e = taskEvent({ id: "t", title: "x", goal_id: null, due_date: "2026-10-15" });
  expect(e.kind).toBe(EVENT_KIND.task);
  expect(e.color).toBe(KIND_STYLE.fixed.color);
  expect(e.glyph).toBe(KIND_STYLE.fixed.glyph);
});
