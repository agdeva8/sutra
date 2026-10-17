import { buildAgenda } from "../agenda";
import { listTodos } from "../todos";

const todo = (id, extra = {}) => ({ id, title: id, horizon: "daily", item_type: "todo", status: "open", ...extra });
const titles = (events) => events.map((e) => `${e.title}${e.done ? "(done)" : ""}`);
const KEYS = ["2026-10-14", "2026-10-15", "2026-10-16"];
const TODAY = new Date(2026, 9, 15, 12);

describe("undated to-dos on the agenda", () => {
  test("an open one sits on today; a done one only on the day it was ticked", () => {
    const state = { plan_items: [
      todo("open"),
      todo("doneToday", { status: "done", done_at: "2026-10-15T09:00:00Z" }),
      todo("doneYesterday", { status: "done", done_at: "2026-10-14T09:00:00Z" }),
    ] };
    const a = buildAgenda(state, KEYS, TODAY);
    expect(titles(a["2026-10-14"])).toEqual(["doneYesterday(done)"]);
    expect(titles(a["2026-10-15"])).toEqual(["open", "doneToday(done)"]);
    expect(a["2026-10-16"]).toEqual([]);
  });

  test("one ticked a moment ago, before the board reloads with done_at, stays on today", () => {
    const a = buildAgenda({ plan_items: [todo("justTicked", { status: "done" })] }, KEYS, TODAY);
    expect(titles(a["2026-10-15"])).toEqual(["justTicked(done)"]);
  });

  test("an open dated to-do from an earlier day is carried to today as overdue", () => {
    const a = buildAgenda({ plan_items: [todo("late", { due_date: "2026-10-14" })] }, KEYS, TODAY);
    expect(a["2026-10-15"][0]).toMatchObject({ title: "late", overdue: true });
  });

  test("a to-do is drawn as a to-do, not a goal task", () => {
    const a = buildAgenda({ plan_items: [todo("buy milk")] }, KEYS, TODAY);
    expect(a["2026-10-15"][0].kind).toBe("todo");
  });
});

describe("the 4-kind board", () => {
  const goals = [{ id: "g", title: "Goal g", status: "active" }];
  const block = (id, over = {}) => ({ id, block_kind: "task", title: id, day: "2026-10-15", goal_id: "g", ...over });
  const day = (state, key) => buildAgenda(state, KEYS, TODAY)[key];

  test("a timed planner session is one entry with its span, the goal and a tickable task", () => {
    const e = day({ goals, blocks: [block("s1", { title: "Deep work", start: "09:00", end: "10:30", placed_by: "planner" })] }, "2026-10-15");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ title: "Deep work", time: "09:00", end: "10:30", kind: "session", goalId: "g", goalTitle: "Goal g", done: false });
    expect(e[0].task.id).toBe("s1");
  });

  test("an untimed day task is a task, not a session", () => {
    const e = day({ goals, blocks: [block("t1", { title: "Read the chapter" })] }, "2026-10-15");
    expect(e[0]).toMatchObject({ title: "Read the chapter", kind: "task", done: false });
    expect(e[0].time).toBeUndefined();
  });

  test("a task with an `at` is a reminder at that moment", () => {
    const e = day({ goals, blocks: [block("r1", { title: "Call mom", at: "18:00", goal_id: null })] }, "2026-10-15");
    expect(e[0]).toMatchObject({ title: "Call mom", kind: "reminder", time: "18:00" });
  });

  test("a repeating reminder appears on exactly its weekdays, up to `until`", () => {
    const state = {
      goals,
      blocks: [block("r2", { title: "Meds", at: "08:00", goal_id: null, day: "2026-10-14", repeat: { weekdays: [2, 3, 4], until: "2026-10-16" } })],
    };
    const a = buildAgenda(state, KEYS, TODAY);
    expect(titles(a["2026-10-14"])).toEqual(["Meds"]);
    expect(titles(a["2026-10-15"])).toEqual(["Meds"]);
    expect(titles(a["2026-10-16"])).toEqual(["Meds"]);
    const stopped = { ...state, blocks: [{ ...state.blocks[0], repeat: { weekdays: [2, 3, 4], until: "2026-10-15" } }] };
    expect(buildAgenda(stopped, KEYS, TODAY)["2026-10-16"]).toEqual([]);
  });

  test("a reached milestone is done", () => {
    const e = day({ goals, blocks: [{ id: "m1", block_kind: "milestone", title: "Ship", goal_id: "g", target_date: "2026-10-15", reached: true }] }, "2026-10-15");
    expect(e[0]).toMatchObject({ title: "Ship", kind: "milestone", done: true });
  });

  test("an away range is one entry per day it covers", () => {
    const state = { goals, blocks: [{ id: "a1", block_kind: "away", title: "Trip", start_date: "2026-10-14", end_date: "2026-10-15" }] };
    const a = buildAgenda(state, KEYS, TODAY);
    expect(titles(a["2026-10-14"])).toEqual(["Trip"]);
    expect(titles(a["2026-10-15"])).toEqual(["Trip"]);
    expect(a["2026-10-16"]).toEqual([]);
  });

  test("a plan row and a block with the same id are listed once, done if either is done", () => {
    const plan = { id: "twin", title: "Twin", horizon: "daily", goal_id: "g", status: "done", due_date: "2026-10-15" };
    const twin = block("twin", { title: "Twin", start: "09:00", end: "10:00" });
    const e = day({ goals, plan_items: [plan], blocks: [twin] }, "2026-10-15");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ title: "Twin", done: true });

    const openPlan = { ...plan, status: "open" };
    const doneBlock = { ...twin, state: "done" };
    expect(day({ goals, plan_items: [openPlan], blocks: [doneBlock] }, "2026-10-15")[0].done).toBe(true);
  });

  test("a marked to-do block is a to-do, not a reminder, even with an `at`", () => {
    const e = day({ goals, blocks: [block("td", { title: "Pay rent", at: "17:00", todo: true, priority: "high", goal_id: null })] }, "2026-10-15");
    expect(e[0]).toMatchObject({ title: "Pay rent", kind: "todo", dueTime: "17:00", priority: "high" });
  });

  test("a backfilled to-do block is recognised by its plan_items id", () => {
    const plan = todo("legacy", { title: "Buy milk", due_date: "2026-10-15" });
    const twin = block("legacy", { title: "Buy milk", at: "17:00", goal_id: null });
    const e = day({ goals, plan_items: [plan], blocks: [twin] }, "2026-10-15");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ title: "Buy milk", kind: "todo" });
  });
});

describe("the to-do list", () => {
  const items = [
    todo("low", { priority: "low", due_date: "2026-10-16" }),
    todo("doneHigh", { priority: "high", status: "done" }),
    todo("high", { priority: "high", due_date: "2026-10-20" }),
    { id: "session", horizon: "daily", goal_id: "g", title: "session", status: "open" },
  ];

  test("done sinks below not-done under every sort, and goal sessions are not to-dos", () => {
    for (const sort of ["due", "priority", "created"]) {
      const out = listTodos(items, { sort }).map((t) => t.id);
      expect(out[out.length - 1]).toBe("doneHigh");
      expect(out).not.toContain("session");
    }
  });

  test("priority sort puts high first", () => {
    expect(listTodos(items, { sort: "priority" }).map((t) => t.id)).toEqual(["high", "low", "doneHigh"]);
  });

  test("the not-done filter hides done ones", () => {
    expect(listTodos(items, { filter: "open" }).map((t) => t.id)).not.toContain("doneHigh");
  });

  test("to-do blocks are listed, and a backfilled twin appears once", () => {
    const blocks = [
      { id: "b1", block_kind: "task", title: "Block todo", todo: true, day: "2026-10-15", at: "17:00", priority: "low", state: "open" },
      { id: "low", block_kind: "task", title: "Backfilled", todo: false, day: "2026-10-16", state: "open" },
      { id: "session", block_kind: "task", title: "Goal work", day: "2026-10-15", state: "open" },
    ];
    const out = listTodos(items, { blocks, sort: "priority" });
    expect(out.map((t) => t.id)).toContain("b1");
    // The `low` plan row wins over its backfilled block copy, and the goal session stays out.
    expect(out.filter((t) => t.id === "low")).toHaveLength(1);
    expect(out.find((t) => t.id === "low").title).toBe("low");
    expect(out.map((t) => t.id)).not.toContain("session");
    expect(out.find((t) => t.id === "b1")).toMatchObject({ due_date: "2026-10-15", due_time: "17:00", status: "open" });
  });
});
