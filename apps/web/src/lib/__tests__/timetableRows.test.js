import { toTimetableRows, toReminderRows, isMilestoneDone } from "../timetableRows";

// 2026-10-19 and 2026-10-26 are Mondays; the contract's weekday 0 is Monday.
const RANGE = { from: "2026-10-12", to: "2026-11-01" };

const event = (id, over = {}) => ({
  id,
  block_kind: "event",
  title: id,
  day: "2026-10-19",
  start: "19:00",
  end: "21:00",
  note: "",
  goal_id: null,
  repeat: null,
  ...over,
});

const task = (id, over = {}) => ({
  id,
  block_kind: "task",
  title: id,
  day: "2026-10-19",
  start: "09:00",
  end: "10:30",
  at: null,
  repeat: null,
  goal_id: "g1",
  why: "",
  placed_by: "user",
  ...over,
});

describe("toTimetableRows", () => {
  test("a timed event becomes a committed row at its day and time", () => {
    expect(toTimetableRows([event("e1", { note: "with the team" })], RANGE)).toEqual([
      {
        id: "e1",
        block_date: "2026-10-19",
        start_time: "19:00",
        end_time: "21:00",
        label: "e1",
        goal_id: null,
        why: "with the team",
        kind: "committed",
      },
    ]);
  });

  test("an all-day event keeps null times, so the card draws it as all-day", () => {
    const [row] = toTimetableRows([event("e1", { start: null, end: null })], RANGE);
    expect(row.start_time).toBeNull();
    expect(row.end_time).toBeNull();
  });

  test("a weekly repeat expands to exactly its occurrences, honouring until", () => {
    const weekly = event("e2", {
      repeat: { weekdays: [0], until: "2026-10-26" },
    });
    const rows = toTimetableRows([weekly], RANGE);
    expect(rows.map((r) => r.block_date)).toEqual(["2026-10-19", "2026-10-26"]);
    expect(rows.map((r) => r.id)).toEqual(["e2:2026-10-19", "e2:2026-10-26"]);
    expect(rows.every((r) => r.source === "recurring" && r.source_id === "e2")).toBe(true);

    const cut = toTimetableRows(
      [event("e3", { repeat: { weekdays: [0], until: "2026-10-20" } })],
      RANGE,
    );
    expect(cut.map((r) => r.block_date)).toEqual(["2026-10-19"]);
  });

  test("a planner session is tentative and names itself as the task it was set aside for", () => {
    const [row] = toTimetableRows([task("s1", { placed_by: "planner", why: "Needs deep work" })], RANGE);
    expect(row).toMatchObject({
      id: "s1",
      block_date: "2026-10-19",
      start_time: "09:00",
      end_time: "10:30",
      label: "s1",
      kind: "tentative",
      source_id: "s1",
      goal_id: "g1",
      why: "Needs deep work",
    });
  });

  test("a user's timed task is committed", () => {
    const [row] = toTimetableRows([task("u1")], RANGE);
    expect(row.kind).toBe("committed");
    expect(row.source_id).toBe("u1");
  });

  test("a task with only `at` is a reminder, not a timetable row", () => {
    expect(toTimetableRows([task("r1", { start: null, end: null, at: "18:00" })], RANGE)).toEqual([]);
  });

  test("a task with no time is a list item, not a timetable row", () => {
    expect(toTimetableRows([task("t1", { start: null, end: null })], RANGE)).toEqual([]);
  });

  test("away and milestone rows are not timetable rows", () => {
    const rows = toTimetableRows(
      [
        { id: "a1", block_kind: "away", title: "Trip", start_date: "2026-10-19", end_date: "2026-10-21" },
        { id: "m1", block_kind: "milestone", title: "Mock test", goal_id: "g1", target_date: "2026-10-24" },
      ],
      RANGE,
    );
    expect(rows).toEqual([]);
  });

  test("an old-shape row passes through unchanged", () => {
    const old = {
      id: "b1",
      block_date: "2026-10-19",
      start_time: "09:00",
      end_time: "10:00",
      label: "Old row",
      kind: "committed",
      source: null,
      source_id: null,
      goal_id: null,
    };
    expect(toTimetableRows([old], RANGE)).toEqual([old]);
  });
});

describe("toReminderRows", () => {
  test("a 4-kind task with an `at` becomes a reminder with its repeat days", () => {
    const reminder = task("r1", {
      start: null,
      end: null,
      at: "18:00",
      repeat: { weekdays: [0], until: null },
      goal_id: null,
    });
    expect(toReminderRows([reminder], RANGE)).toEqual([
      {
        id: "r1",
        title: "r1",
        goal_id: null,
        days: ["2026-10-19", "2026-10-26"],
        times: ["18:00"],
      },
    ]);
  });

  test("a one-off reminder falls on its own day", () => {
    const reminder = task("r2", { start: null, end: null, at: "07:30", day: "2026-10-20" });
    expect(toReminderRows([reminder], RANGE)[0].days).toEqual(["2026-10-20"]);
  });

  test("a timed task is not a reminder", () => {
    expect(toReminderRows([task("u1")], RANGE)).toEqual([]);
  });

  test("an old-shape reminder passes through unchanged", () => {
    const old = { id: "old", title: "Old", days: ["2026-10-19"], times: ["09:00"] };
    expect(toReminderRows([old], RANGE)).toEqual([old]);
  });
});

describe("isMilestoneDone", () => {
  test("reached and the old status both count as done", () => {
    expect(isMilestoneDone({ reached: true })).toBe(true);
    expect(isMilestoneDone({ status: "done" })).toBe(true);
    expect(isMilestoneDone({ reached: false, status: "open" })).toBe(false);
  });
});
