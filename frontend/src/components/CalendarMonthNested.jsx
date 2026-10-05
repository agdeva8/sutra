import React, { useMemo } from "react";

/**
 * CalendarMonthNested — the Timeline month view.
 *
 * All days are columns (no week-row wrapping, no label sidebar). Each goal is a
 * box spanning its days; inside it sit that goal's milestone boxes; inside each
 * milestone sit its WEEKLY plan_items. The same items feed every zoom, so a
 * blocker/task added here shows up in the other views.
 *
 * Vertical column lines are drawn IN FRONT of the boxes but BEHIND the text, so
 * the grid reads across the colours without ever cutting a letter. Weekends get
 * a grey tint overlay; Monday's line is one shade darker.
 *
 * `goals` carry the resolved span + colour (built by the caller from allItems +
 * GOAL_PALETTE); `milestones` are the normalized milestones; `planItems` are the
 * raw state.plan_items.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
const parseDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? new Date(v) : new Date(`${String(v).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : startOfDay(d);
};
const clamp = (d, lo, hi) => (d < lo ? lo : d > hi ? hi : d);
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
  let start = parseDate(p.start_date);
  let end = parseDate(p.end_date);
  const due = parseDate(p.due_date);
  if (start && end) return { start, end };
  if (due && !start && !end) {
    // Monday-anchored week around the due date.
    const d = due;
    const wd = d.getDay();
    const mon = addDays(d, wd === 0 ? -6 : 1 - wd);
    return { start: mon, end: addDays(mon, 6) };
  }
  return { start: start || end || due, end: end || start || due };
}

export default function CalendarMonthNested({
  anchor,
  goals = [],
  milestones = [],
  planItems = [],
  blockers = [],
  selectedGoalIds,
  onSelectItem,
  onSelectDay,
}) {
  const model = useMemo(() => {
    const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth(), daysInMonth);
    const days = Array.from({ length: daysInMonth }, (_, i) => addDays(monthStart, i));
    const todayIso = iso(new Date());

    const weekly = (planItems || []).filter((p) => p && p.horizon === "weekly");

    // Only render what overlaps the visible month; clip partial overlaps.
    // Never clamp an out-of-month item onto the boundary — that piles Nov/Dec
    // milestones and weekly items onto the last day of the month.
    const inMonth = (s, e) => {
      if (!s || !e) return null;
      const a = s < monthStart ? monthStart : s;
      const b = e > monthEnd ? monthEnd : e;
      return b < a ? null : { start: a, end: b };
    };

    const rows = [];
    for (const g of goals) {
      if (selectedGoalIds && !selectedGoalIds.has(g.id)) continue;
      const gSpan = inMonth(parseDate(g.start) || monthStart, parseDate(g.end) || monthEnd);
      if (!gSpan) continue;
      const { start: gStart, end: gEnd } = gSpan;
      const gMilestones = (milestones || [])
        .filter((m) => m.goalId === g.id && m.date)
        .sort((a, b) => a.date - b.date);

      const goalTasks = weekly.filter((p) => p.goal_id === g.id);
      const used = new Set();

      const ms = gMilestones
        .map((m, i) => {
          const prevTarget = i === 0 ? gStart : gMilestones[i - 1].date;
          const mStartRaw = i === 0 ? gStart : addDays(prevTarget, 1);
          const span = inMonth(mStartRaw < gStart ? gStart : mStartRaw, m.date);
          if (!span) return null; // milestone entirely outside this month
          const { start, end } = span;
          // Attach weekly items by phase, else by overlapping the window.
          const tasks = goalTasks
            .filter((p) => {
              if (used.has(p.id)) return false;
              const r = itemRange(p);
              if (!r.start || !r.end) return false;
              if (m.phase && p.phase) return p.phase === m.phase;
              return r.end >= start && r.start <= end;
            })
            .map((p) => {
              const r = itemRange(p);
              const tspan = inMonth(Math.max(r.start, start), Math.min(r.end, end));
              if (!tspan) return null;
              used.add(p.id);
              return {
                id: p.id,
                item: { ...p, kind: "plan", title: p.title, milestone: m.title, date: r.start },
                title: p.title,
                start: tspan.start,
                end: tspan.end,
                hours: p.weekly_hours ? `${p.weekly_hours}h/wk` : "",
              };
            })
            .filter(Boolean);
          return { id: m.id, item: { ...m, kind: "milestone" }, title: m.title, start, end, tasks };
        })
        .filter(Boolean);

      // Weekly items that matched no milestone hang directly under the goal.
      const orphans = goalTasks
        .filter((p) => !used.has(p.id))
        .map((p) => {
          const r = itemRange(p);
          const tspan = inMonth(
            Math.max(r.start || gStart, gStart),
            Math.min(r.end || gEnd, gEnd),
          );
          if (!tspan) return null;
          return {
            id: p.id,
            item: { ...p, kind: "plan", title: p.title, date: r.start },
            title: p.title,
            start: tspan.start,
            end: tspan.end,
            hours: p.weekly_hours ? `${p.weekly_hours}h/wk` : "",
          };
        })
        .filter(Boolean);

      rows.push({
        id: g.id,
        item: { ...g, kind: "goal" },
        title: g.title,
        color: g.color,
        start: gStart,
        end: gEnd,
        milestones: ms,
        orphans,
      });
    }

    // Blockers are constraints, not tasks — they span days and always show.
    const blockerRows = (blockers || [])
      .map((b) => {
        const s = parseDate(b.start);
        const e = parseDate(b.end) || s;
        if (!s || !e || e < monthStart || s > monthEnd) return null;
        return {
          id: b.id,
          item: { ...b, kind: "blocker" },
          title: b.title,
          start: clamp(s, monthStart, monthEnd),
          end: clamp(e, monthStart, monthEnd),
        };
      })
      .filter(Boolean);

    return { monthStart, monthEnd, days, todayIso, rows, blockerRows };
  }, [anchor, goals, milestones, planItems, blockers, selectedGoalIds]);

  const { days, todayIso, rows, blockerRows } = model;
  const allRows = [...blockerRows, ...rows];
  const n = days.length;
  const dayNum = (d) => d.getDate();
  const colStart = (d) => clamp(dayNum(d), 1, n);
  const colEnd = (d) => clamp(dayNum(d), 1, n);

  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;
  const isMonday = (d) => d.getDay() === 1;
  const colLine = (d) =>
    dayNum(d) === 1
      ? ""
      : isMonday(d)
        ? "border-l border-[var(--border-accent)]"
        : "border-l border-[color-mix(in_srgb,var(--border)_60%,transparent)]";

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]">
      <div className="min-w-[680px] sm:min-w-0">
        {/* day header — clicking a day adds to it */}
        <div
          className="grid border-b border-[var(--border-accent)]"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
        >
          {days.map((d) => {
            const isToday = iso(d) === todayIso;
            return (
              <button
                key={iso(d)}
                type="button"
                onClick={() => onSelectDay?.(d)}
                aria-label={`Add on ${d.toDateString()}`}
                className={`flex flex-col items-center py-0.5 leading-none hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] ${colLine(d)} ${
                  isWeekend(d) ? "bg-[color-mix(in_srgb,var(--text-muted)_6%,transparent)]" : ""
                }`}
              >
                <span className="text-[8px] text-[var(--text-muted)]">{WEEKDAYS[(d.getDay() + 6) % 7][0]}</span>
                <span
                  className={`mt-0.5 text-[10px] tabular-nums ${
                    isToday
                      ? "rounded-full bg-[var(--accent)] px-1 font-semibold text-[var(--bg-primary)]"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  {dayNum(d)}
                </span>
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
              {/* background day cells (click to add) */}
              {allRows.map((r, gi) =>
                days.map((d, ci) => (
                  <button
                    key={`bg-${r.id}-${ci}`}
                    type="button"
                    onClick={() => onSelectDay?.(d)}
                    aria-label={`Add on ${d.toDateString()}`}
                    style={{ gridColumn: ci + 1, gridRow: gi + 1 }}
                    className={`hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] ${
                      iso(d) === todayIso ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg-primary))]" : ""
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
                {days.map((d) => (
                  <div
                    key={`ln-${iso(d)}`}
                    className={`${colLine(d)} ${
                      isWeekend(d) ? "bg-[color-mix(in_srgb,var(--text-muted)_6%,transparent)]" : ""
                    }`}
                  />
                ))}
              </div>

              {/* blockers — constraints spanning days, above the goals */}
              {blockerRows.map((b, bi) => (
                <div
                  key={b.id}
                  style={{ gridColumn: `${colStart(b.start)} / ${colEnd(b.end) + 1}`, gridRow: bi + 1 }}
                  className="p-1"
                >
                  <button
                    type="button"
                    onClick={() => onSelectItem?.(b.item)}
                    style={{
                      background: "color-mix(in srgb, var(--danger) 14%, var(--bg-primary))",
                      border: "1px solid color-mix(in srgb, var(--danger) 55%, transparent)",
                    }}
                    className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                  >
                    <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] text-[var(--danger)]">▲</span>
                    <span className="relative z-30 min-w-0 truncate text-[10px] font-semibold text-[var(--text-primary)]">{b.title}</span>
                    <span className="relative z-30 ml-auto shrink-0 text-[8px] uppercase tracking-wide text-[var(--danger)]">blocker</span>
                  </button>
                </div>
              ))}

              {rows.map((g, gi) => {
                const gSpan = colEnd(g.end) - colStart(g.start) + 1;
                return (
                  <div
                    key={g.id}
                    style={{ gridColumn: `${colStart(g.start)} / ${colEnd(g.end) + 1}`, gridRow: blockerRows.length + gi + 1 }}
                    className="p-1"
                  >
                    <div className="rounded-md p-1" style={boxStyle(g.color, 0)}>
                      <button
                        type="button"
                        onClick={() => onSelectItem?.(g.item)}
                        className="flex w-full items-center gap-1 rounded-[2px] px-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                      >
                        <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] opacity-70">◎</span>
                        <span className="relative z-30 min-w-0 truncate text-[10px] font-bold text-[var(--text-primary)]">{g.title}</span>
                      </button>

                      <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${gSpan}, minmax(0, 1fr))`, gap: 2 }}>
                        {g.milestones.map((m, mi) => {
                          const lc = colStart(m.start) - colStart(g.start) + 1;
                          const rc = colEnd(m.end) - colStart(g.start) + 1;
                          const mSpan = rc - lc + 1;
                          if (mSpan < 1) return null;
                          return (
                            <div key={m.id || mi} style={{ gridColumn: `${lc} / ${rc + 1}` }}>
                              <div className="rounded-md p-1" style={boxStyle(g.color, 1)}>
                                <button
                                  type="button"
                                  onClick={() => onSelectItem?.(m.item)}
                                  className="flex w-full items-center gap-1 rounded-[2px] px-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                >
                                  <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] opacity-70">◆</span>
                                  <span className="relative z-30 min-w-0 truncate text-[9px] font-semibold text-[var(--text-primary)]">{m.title}</span>
                                </button>

                                <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${mSpan}, minmax(0, 1fr))`, gap: 2 }}>
                                  {m.tasks.map((t) => {
                                    const tlc = Math.max(1, colStart(t.start) - colStart(m.start) + 1);
                                    const trc = Math.min(mSpan, colEnd(t.end) - colStart(m.start) + 1);
                                    if (trc < tlc) return null;
                                    return (
                                      <button
                                        key={t.id}
                                        type="button"
                                        onClick={() => onSelectItem?.(t.item)}
                                        style={{ gridColumn: `${tlc} / ${trc + 1}`, ...boxStyle(g.color, 2) }}
                                        className="flex min-w-0 items-center gap-1 rounded px-1 py-[1px] text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                      >
                                        <span aria-hidden="true" className="relative z-30 shrink-0 text-[8px] opacity-70">○</span>
                                        <span className="relative z-30 min-w-0 truncate text-[9px] font-medium leading-tight text-[var(--text-primary)]">{t.title}</span>
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
                            const tlc = Math.max(1, colStart(t.start) - colStart(g.start) + 1);
                            const trc = Math.min(gSpan, colEnd(t.end) - colStart(g.start) + 1);
                            if (trc < tlc) return null;
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => onSelectItem?.(t.item)}
                                style={{ gridColumn: `${tlc} / ${trc + 1}`, ...boxStyle(g.color, 2) }}
                                className="flex min-w-0 items-center gap-1 rounded px-1 py-[1px] text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                              >
                                <span aria-hidden="true" className="relative z-30 shrink-0 text-[8px] opacity-70">○</span>
                                <span className="relative z-30 min-w-0 truncate text-[9px] font-medium leading-tight text-[var(--text-primary)]">{t.title}</span>
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
