import React, { useMemo } from "react";

/**
 * CalendarNestedView — the Timeline's shared calendar layout for every zoom.
 *
 * The column unit is the smallest unit of the current span:
 *   day    → one column per day    (Day: 1, Week: 7, Month: ~30)
 *   week   → one column per week   (3 Months: ~13)
 *   month  → one column per month  (Year: 12)
 *
 * Each goal is a box spanning its columns; inside it sit that goal's milestone
 * boxes; inside each milestone sit its weekly plan_items. The goal ▸ milestone
 * ▸ task hierarchy reads the same at every zoom. Passing only `anchor` keeps the
 * original single-month view.
 *
 * Vertical column lines are drawn IN FRONT of the boxes but BEHIND the text, so
 * the grid reads across the colours without ever cutting a letter. Weekends get
 * a grey tint overlay; Monday's line is one shade darker.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeek = (d) => addDays(startOfDay(d), -((startOfDay(d).getDay() + 6) % 7));
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const parseDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? new Date(v) : new Date(`${String(v).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : startOfDay(d);
};
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Depth → fill/border (goal lightest, task darkest).
const boxStyle = (color, depth) => ({
  background: `color-mix(in srgb, ${color} ${[10, 24, 44][depth]}%, var(--bg-primary))`,
  border: `1px solid color-mix(in srgb, ${color} ${[45, 62, 80][depth]}%, transparent)`,
});

/** Multi-select goal filter. Keeps at least one goal visible. */
export function GoalFilter({ goals, selected, onToggle, onAll }) {
  const allOn = selected.size === goals.length;
  return (
    <div
      role="group"
      aria-label="Choose which goals to show"
      className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible"
    >
      <button
        type="button"
        onClick={onAll}
        aria-pressed={allOn}
        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
          allOn
            ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,var(--bg-primary))] text-[var(--text-primary)]"
            : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
        }`}
      >
        All
      </button>
      {goals.map((g) => {
        const on = selected.has(g.id);
        const onlyOne = on && selected.size === 1;
        return (
          <button
            key={g.id}
            type="button"
            aria-pressed={on}
            disabled={onlyOne}
            title={onlyOne ? "At least one goal must stay visible" : g.title}
            onClick={() => onToggle(g.id)}
            className={`flex max-w-[200px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed ${
              on
                ? "text-[var(--text-primary)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}
            style={
              on
                ? {
                    background: `color-mix(in srgb, ${g.color} 20%, var(--bg-primary))`,
                    borderColor: `color-mix(in srgb, ${g.color} 55%, transparent)`,
                  }
                : undefined
            }
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: g.color, opacity: on ? 1 : 0.35 }} />
            <span className="truncate">{g.title}</span>
            {on && !onlyOne && <span aria-hidden="true" className="shrink-0 text-[9px] opacity-60">✕</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Snap a task/plan-item window to whole days; single-day items snap to their week. */
function itemRange(p) {
  const start = parseDate(p.start_date);
  const end = parseDate(p.end_date);
  const due = parseDate(p.due_date);
  if (start && end) return { start, end };
  if (due && !start && !end) {
    const mon = startOfWeek(due);
    return { start: mon, end: addDays(mon, 6) };
  }
  return { start: start || end || due, end: end || start || due };
}

export default function CalendarNestedView({
  anchor,
  start: startProp,
  end: endProp,
  unit = "day",
  goals = [],
  milestones = [],
  planItems = [],
  blockers = [],
  selectedGoalIds,
  onSelectItem,
  onSelectDay,
}) {
  const model = useMemo(() => {
    const base = anchor || new Date();
    const rangeStart = startOfDay(startProp || startOfMonth(base));
    const rangeEnd = startOfDay(endProp || endOfMonth(base));

    // Columns — the smallest unit of the current span.
    const columns = [];
    if (unit === "week") {
      for (let w = startOfWeek(rangeStart); w <= rangeEnd; w = addDays(w, 7)) {
        columns.push({ key: iso(w), start: w, end: addDays(w, 6), date: w });
      }
    } else if (unit === "month") {
      for (let m = startOfMonth(rangeStart); m <= rangeEnd; m = addMonths(m, 1)) {
        columns.push({ key: iso(m), start: m, end: endOfMonth(m), date: m });
      }
    } else {
      for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) {
        columns.push({ key: iso(d), start: d, end: d, date: d });
      }
    }

    const today = startOfDay(new Date());
    const maxD = (a, b) => (a > b ? a : b);
    const minD = (a, b) => (a < b ? a : b);

    // Map a date range to the column indices it covers, clamped to the range.
    // Never clamp an out-of-range item onto the boundary.
    const spanOf = (s, e) => {
      if (!s || !e) return null;
      const a = s < rangeStart ? rangeStart : s;
      const b = e > rangeEnd ? rangeEnd : e;
      if (b < a) return null;
      let i = -1;
      let j = -1;
      for (let k = 0; k < columns.length; k++) {
        if (columns[k].end >= a) {
          i = k;
          break;
        }
      }
      for (let k = columns.length - 1; k >= 0; k--) {
        if (columns[k].start <= b) {
          j = k;
          break;
        }
      }
      if (i < 0 || j < 0 || j < i) return null;
      return { i, j, start: columns[i].start, end: columns[j].end };
    };

    const weekly = (planItems || []).filter((p) => p && p.horizon === "weekly");

    const rows = [];
    for (const g of goals) {
      if (selectedGoalIds && !selectedGoalIds.has(g.id)) continue;
      const gSpan = spanOf(parseDate(g.start) || rangeStart, parseDate(g.end) || rangeEnd);
      if (!gSpan) continue;

      const gMilestones = (milestones || [])
        .filter((m) => m.goalId === g.id && m.date)
        .sort((a, b) => a.date - b.date);

      const goalTasks = weekly.filter((p) => p.goal_id === g.id);
      const used = new Set();

      const ms = gMilestones
        .map((m, idx) => {
          const prevTarget = idx === 0 ? gSpan.start : gMilestones[idx - 1].date;
          const mStartRaw = idx === 0 ? gSpan.start : addDays(prevTarget, 1);
          const mSpan = spanOf(mStartRaw < gSpan.start ? gSpan.start : mStartRaw, m.date);
          if (!mSpan) return null; // milestone entirely outside this range
          // Attach weekly items by phase, else by overlapping the window.
          const tasks = goalTasks
            .filter((p) => {
              if (used.has(p.id)) return false;
              const r = itemRange(p);
              if (!r.start || !r.end) return false;
              if (m.phase && p.phase) return p.phase === m.phase;
              return r.end >= mSpan.start && r.start <= mSpan.end;
            })
            .map((p) => {
              const r = itemRange(p);
              const tSpan = spanOf(maxD(r.start, mSpan.start), minD(r.end, mSpan.end));
              if (!tSpan) return null;
              used.add(p.id);
              return {
                id: p.id,
                item: { ...p, kind: "plan", title: p.title, milestone: m.title, date: r.start },
                title: p.title,
                span: tSpan,
                hours: p.weekly_hours ? `${p.weekly_hours}h/wk` : "",
              };
            })
            .filter(Boolean);
          return { id: m.id, item: { ...m, kind: "milestone" }, title: m.title, span: mSpan, tasks };
        })
        .filter(Boolean);

      // Weekly items that matched no milestone hang directly under the goal.
      const orphans = goalTasks
        .filter((p) => !used.has(p.id))
        .map((p) => {
          const r = itemRange(p);
          const tSpan = spanOf(
            maxD(r.start || gSpan.start, gSpan.start),
            minD(r.end || gSpan.end, gSpan.end),
          );
          if (!tSpan) return null;
          return {
            id: p.id,
            item: { ...p, kind: "plan", title: p.title, date: r.start },
            title: p.title,
            span: tSpan,
            hours: p.weekly_hours ? `${p.weekly_hours}h/wk` : "",
          };
        })
        .filter(Boolean);

      rows.push({
        id: g.id,
        item: { ...g, kind: "goal" },
        title: g.title,
        color: g.color,
        span: gSpan,
        milestones: ms,
        orphans,
      });
    }

    // Blockers are constraints, not tasks — they span columns and always show.
    const blockerRows = (blockers || [])
      .map((b) => {
        const s = parseDate(b.start);
        const e = parseDate(b.end) || s;
        const bSpan = spanOf(s, e);
        if (!bSpan) return null;
        return { id: b.id, item: { ...b, kind: "blocker" }, title: b.title, span: bSpan };
      })
      .filter(Boolean);

    return { columns, today, rows, blockerRows };
  }, [anchor, startProp, endProp, unit, goals, milestones, planItems, blockers, selectedGoalIds]);

  const { columns, today, rows, blockerRows } = model;
  const allRows = [...blockerRows, ...rows];
  const n = Math.max(columns.length, 1);
  const isToday = (c) => today >= c.start && today <= c.end;
  const isWeekend = (c) => unit === "day" && (c.date.getDay() === 0 || c.date.getDay() === 6);
  const colLine = (ci, c) =>
    ci === 0
      ? ""
      : unit === "day" && c.date.getDay() === 1
        ? "border-l border-[var(--border-accent)]"
        : "border-l border-[color-mix(in_srgb,var(--border)_60%,transparent)]";

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]">
      <div style={{ minWidth: n > 7 ? 680 : undefined }}>
        {/* column header — clicking a column adds to its first day */}
        <div
          className="grid border-b border-[var(--border-accent)]"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {columns.map((c, ci) => {
            const now = isToday(c);
            const dayPill = `mt-0.5 text-[10px] tabular-nums ${
              now
                ? "rounded-full bg-[var(--accent)] px-1 font-semibold text-[var(--bg-primary)]"
                : "text-[var(--text-secondary)]"
            }`;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => onSelectDay?.(c.date)}
                aria-label={`Add on ${c.date.toDateString()}`}
                className={`flex flex-col items-center py-0.5 leading-none hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] ${colLine(ci, c)} ${
                  isWeekend(c) ? "bg-[color-mix(in_srgb,var(--text-muted)_6%,transparent)]" : ""
                }`}
              >
                {unit === "day" ? (
                  <>
                    <span className="text-[8px] text-[var(--text-muted)]">{WEEKDAYS[(c.date.getDay() + 6) % 7][0]}</span>
                    <span className={dayPill}>{c.date.getDate()}</span>
                  </>
                ) : unit === "week" ? (
                  <span className={`py-0.5 text-[8px] tabular-nums ${now ? "rounded-full bg-[var(--accent)] px-1 font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]"}`}>
                    {MONTHS[c.date.getMonth()]} {c.date.getDate()}
                  </span>
                ) : (
                  <span className={`py-0.5 text-[9px] font-medium ${now ? "rounded-full bg-[var(--accent)] px-1 font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]"}`}>
                    {MONTHS[c.date.getMonth()]}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* One row per goal: goal box ▸ milestone boxes ▸ weekly task boxes. */}
        <div
          className="relative grid"
          style={{
            gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${Math.max(allRows.length, 1)}, auto)`,
          }}
        >
          {allRows.length === 0 ? (
            <div className="col-span-full px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">
              Select at least one goal.
            </div>
          ) : (
            <>
              {/* background column cells (click to add) */}
              {allRows.map((r, gi) =>
                columns.map((c, ci) => (
                  <button
                    key={`bg-${r.id}-${ci}`}
                    type="button"
                    onClick={() => onSelectDay?.(c.date)}
                    aria-label={`Add on ${c.date.toDateString()}`}
                    style={{ gridColumn: ci + 1, gridRow: gi + 1 }}
                    className={`hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] ${
                      isToday(c) ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg-primary))]" : ""
                    }`}
                  />
                )),
              )}

              {/* vertical-line overlay: in front of boxes, behind text */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 grid"
                style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
              >
                {columns.map((c, ci) => (
                  <div
                    key={`ln-${c.key}`}
                    className={`${colLine(ci, c)} ${
                      isWeekend(c) ? "bg-[color-mix(in_srgb,var(--text-muted)_6%,transparent)]" : ""
                    }`}
                  />
                ))}
              </div>

              {/* blockers — constraints spanning columns, above the goals */}
              {blockerRows.map((b, bi) => (
                <div
                  key={b.id}
                  style={{ gridColumn: `${b.span.i + 1} / ${b.span.j + 2}`, gridRow: bi + 1 }}
                  className="p-1"
                >
                  <button
                    type="button"
                    onClick={() => onSelectItem?.(b.item)}
                    style={{
                      background: "color-mix(in srgb, var(--danger) 14%, var(--bg-primary))",
                      border: "1px solid color-mix(in srgb, var(--danger) 55%, transparent)",
                    }}
                    className="flex w-full items-start gap-1 rounded px-1.5 py-0.5 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                  >
                    <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] text-[var(--danger)]">▲</span>
                    <span className="relative z-30 min-w-0 whitespace-normal break-words text-[10px] font-semibold leading-tight text-[var(--text-primary)]">{b.title}</span>
                    <span className="relative z-30 ml-auto shrink-0 text-[8px] uppercase tracking-wide text-[var(--danger)]">blocker</span>
                  </button>
                </div>
              ))}

              {rows.map((g, gi) => {
                const gSpan = g.span.j - g.span.i + 1;
                return (
                  <div
                    key={g.id}
                    style={{ gridColumn: `${g.span.i + 1} / ${g.span.j + 2}`, gridRow: blockerRows.length + gi + 1 }}
                    className="p-1"
                  >
                    <div className="rounded-md p-1" style={boxStyle(g.color, 0)}>
                      <button
                        type="button"
                        onClick={() => onSelectItem?.(g.item)}
                        className="flex w-full items-start gap-1 rounded-[2px] px-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                      >
                        <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] opacity-70">◎</span>
                        <span className="relative z-30 min-w-0 whitespace-normal break-words text-[10px] font-bold leading-tight text-[var(--text-primary)]">{g.title}</span>
                      </button>

                      <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${gSpan}, minmax(0, 1fr))`, gap: 2 }}>
                        {g.milestones.map((m, mi) => {
                          const lc = m.span.i - g.span.i + 1;
                          const rc = m.span.j - g.span.i + 1;
                          const mSpan = rc - lc + 1;
                          if (mSpan < 1) return null;
                          return (
                            <div key={m.id || mi} style={{ gridColumn: `${lc} / ${rc + 1}` }}>
                              <div className="rounded-md p-1" style={boxStyle(g.color, 1)}>
                                <button
                                  type="button"
                                  onClick={() => onSelectItem?.(m.item)}
                                  className="flex w-full items-start gap-1 rounded-[2px] px-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                >
                                  <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] opacity-70">◆</span>
                                  <span className="relative z-30 min-w-0 whitespace-normal break-words text-[9px] font-semibold leading-tight text-[var(--text-primary)]">{m.title}</span>
                                </button>

                                <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${mSpan}, minmax(0, 1fr))`, gap: 2 }}>
                                  {m.tasks.map((t) => {
                                    const tlc = Math.max(1, t.span.i - m.span.i + 1);
                                    const trc = Math.min(mSpan, t.span.j - m.span.i + 1);
                                    if (trc < tlc) return null;
                                    return (
                                      <button
                                        key={t.id}
                                        type="button"
                                        onClick={() => onSelectItem?.(t.item)}
                                        style={{ gridColumn: `${tlc} / ${trc + 1}`, ...boxStyle(g.color, 2) }}
                                        className="flex min-w-0 items-start gap-1 rounded px-1 py-[1px] text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                      >
                                        <span aria-hidden="true" className="relative z-30 shrink-0 text-[8px] opacity-70">○</span>
                                        <span className="relative z-30 min-w-0 whitespace-normal break-words text-[9px] font-medium leading-tight text-[var(--text-primary)]">{t.title}</span>
                                        {t.hours && <span className="relative z-30 ml-auto shrink-0 text-[8px] tabular-nums opacity-70">{t.hours}</span>}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* weekly items that matched no milestone, still inside the goal */}
                      {g.orphans.length > 0 && (
                        <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${gSpan}, minmax(0, 1fr))`, gap: 2 }}>
                          {g.orphans.map((t) => {
                            const tlc = Math.max(1, t.span.i - g.span.i + 1);
                            const trc = Math.min(gSpan, t.span.j - g.span.i + 1);
                            if (trc < tlc) return null;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => onSelectItem?.(t.item)}
                                style={{ gridColumn: `${tlc} / ${trc + 1}`, ...boxStyle(g.color, 2) }}
                                className="flex min-w-0 items-start gap-1 rounded px-1 py-[1px] text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                              >
                                <span aria-hidden="true" className="relative z-30 shrink-0 text-[8px] opacity-70">○</span>
                                <span className="relative z-30 min-w-0 whitespace-normal break-words text-[9px] font-medium leading-tight text-[var(--text-primary)]">{t.title}</span>
                                {t.hours && <span className="relative z-30 ml-auto shrink-0 text-[8px] tabular-nums opacity-70">{t.hours}</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
