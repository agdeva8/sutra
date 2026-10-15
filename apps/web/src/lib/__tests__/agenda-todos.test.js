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
});
