import React, { useState } from "react";

/**
 * Nested spanning bars — one continuous bar per RANGE instead of one card per
 * DAY. A goal, its milestones and their tasks nest by depth and darken at each
 * level:
 *
 *   goal       depth 0 — lightest wash of the goal colour
 *   milestone  depth 1 — a few shades darker, inset inside the goal span
 *   task       depth 2 — darkest, inset inside its milestone span
 *
 * Click empty day space  → add to day (opens AddToDayDialog in the real app).
 * Click any coloured bar → item details, carrying task › milestone › goal.
 *
 * This is a design sample: the calendar below is mocked, the clicks only drive
 * an inline inspector so the hierarchy is visible without wiring the real
 * dialogs.
 */

const BLUE = "#0A84FF";

// ── Mock hierarchy (October 2026, matching the live calendar) ────────────────
const GOAL = { title: "Switch to a new job within 3 months", start: 1, end: 31 };
const MILESTONES = [
  {
    title: "Target list of 15 roles and master resume finalized",
    start: 5,
    end: 16,
    tasks: [
      { title: "Build the 15-role target list and master resume", start: 5, end: 11, hours: "6h" },
      { title: "Finalize the target list", start: 12, end: 16, hours: "2h" },
    ],
  },
  {
    title: "3 STAR stories and 1 system design walkthrough recorded",
    start: 19,
    end: 27,
    tasks: [
      { title: "Record one STAR story and walkthrough", start: 19, end: 23, hours: "3h" },
      { title: "Record the remaining STAR stories", start: 24, end: 27, hours: "2h" },
    ],
  },
  {
    title: "10 tailored applications submitted",
    start: 28,
    end: 31,
    tasks: [{ title: "Tailor 10 applications", start: 28, end: 31, hours: "4h" }],
  },
];

// Flatten into ordered tracks: goal, then each milestone followed by its tasks.
const TRACKS = (() => {
  const t = [{ kind: "goal", depth: 0, title: GOAL.title, start: GOAL.start, end: GOAL.end }];
  for (const m of MILESTONES) {
    t.push({ kind: "milestone", depth: 1, title: m.title, start: m.start, end: m.end, goalTitle: GOAL.title });
    for (const task of m.tasks) {
      t.push({
        kind: "task",
        depth: 2,
        title: task.title,
        start: task.start,
        end: task.end,
        hours: task.hours,
        milestoneTitle: m.title,
        goalTitle: GOAL.title,
      });
    }
  }
  return t;
})();

// ── Dates ────────────────────────────────────────────────────────────────────
const Y = 2026;
const M = 9; // October
const at = (d) => new Date(Y, M, d);
const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfWeek = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
};
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthWeeks(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const weeks = [];
  for (let cur = start; cur <= end; cur = addDays(cur, 7)) {
    const week = [];
    for (let i = 0; i < 7; i++) week.push(addDays(cur, i));
    weeks.push(week);
  }
  return weeks;
}

// Depth → fill. Light for the goal, darker per level.
const fill = (depth) => `color-mix(in srgb, ${BLUE} ${[14, 34, 54][depth]}%, var(--bg-primary))`;
const GLYPH = { goal: "◎", milestone: "◆", task: "○" };

/** Segment a track into the current week: { startCol, endCol, opensLeft/Right }. */
function segment(track, week) {
  const s = at(track.start);
  const e = at(track.end);
  const weekStart = week[0];
  const weekEnd = addDays(week[6], 1);
  if (e < weekStart || s >= weekEnd) return null;
  const segStart = s < weekStart ? weekStart : s;
  const segEnd = e >= weekEnd ? addDays(week[6], 1) : addDays(e, 1);
  let startCol = 1;
  let endCol = 7;
  for (let i = 0; i < 7; i++) {
    if (week[i] >= segStart) {
      startCol = i + 1;
      break;
    }
  }
  for (let i = 6; i >= 0; i--) {
    if (week[i] < segEnd) {
      endCol = i + 1;
      break;
    }
  }
  return { startCol, endCol, opensLeft: s < weekStart, opensRight: e >= weekEnd };
}

function SpanBar({ track, seg, onSelect }) {
  const inset = track.depth * 16;
  return (
    <div style={{ paddingLeft: inset, paddingRight: track.depth * 6 }} className="h-full">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(track);
        }}
        aria-label={`${track.kind}: ${track.title}`}
        className="flex h-full w-full items-center gap-1.5 overflow-hidden rounded-[3px] px-2 text-left transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
        style={{
          background: fill(track.depth),
          boxShadow: `inset 3px 0 0 0 ${BLUE}`,
          color: "var(--text-primary)",
        }}
      >
        <span aria-hidden="true" className="shrink-0 text-[10px] opacity-80">
          {seg.opensLeft ? "◂" : ""}
          {GLYPH[track.kind]}
        </span>
        <span className={`truncate text-[11px] leading-none ${track.depth === 0 ? "font-semibold" : "font-medium"}`}>
          {track.title}
        </span>
        {track.hours && <span className="ml-auto shrink-0 text-[9px] tabular-nums opacity-70">{track.hours}</span>}
        {seg.opensRight && <span aria-hidden="true" className="shrink-0 opacity-50">▸</span>}
      </button>
    </div>
  );
}

function NestedSpansCalendar({ onSelectDay, onSelectTrack }) {
  const weeks = monthWeeks(at(1));
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]">
      <div className="grid grid-cols-7 border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[var(--text-muted)] select-none">
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => {
        // Lanes for this week = every track that intersects it, in hierarchy
        // order, so parent bars sit above their children.
        const placed = TRACKS.map((track) => ({ track, seg: segment(track, week) })).filter((x) => x.seg);
        return (
          <div
            key={wi}
            className="relative grid border-b border-[var(--border)] last:border-b-0"
            style={{
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gridTemplateRows: `auto repeat(${Math.max(1, placed.length)}, 30px)`,
            }}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-7">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className={i === 0 ? "" : "border-l border-[var(--border)]"} />
              ))}
            </div>

            {week.map((date, ci) => {
              const inMonth = date.getMonth() === M;
              const isToday = date.toDateString() === new Date().toDateString();
              return (
                <div
                  key={ci}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectDay(date)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectDay(date);
                    }
                  }}
                  aria-label={`${date.toDateString()} — add to day`}
                  className={[
                    "relative row-start-1 cursor-pointer px-1.5 pt-1 pb-1 hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
                    inMonth ? "" : "opacity-40",
                    isToday ? "ring-1 ring-inset ring-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-primary))]" : "",
                  ].join(" ")}
                  style={{ gridColumn: ci + 1, gridRow: 1 }}
                >
                  <div className="mb-1 flex justify-end">
                    <span
                      className={[
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                        isToday ? "bg-[var(--accent)] font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]",
                      ].join(" ")}
                    >
                      {date.getDate()}
                    </span>
                  </div>
                </div>
              );
            })}

            {placed.map(({ track, seg }, lane) => (
              <div
                key={track.kind + track.title + lane}
                style={{
                  gridColumn: `${seg.startCol} / ${seg.endCol + 1}`,
                  gridRow: lane + 2,
                  padding: "1px 3px",
                }}
              >
                <SpanBar track={track} seg={seg} onSelect={onSelectTrack} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Inspector({ selection }) {
  if (selection.type === "day") {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
        <div className="text-[11px] font-semibold text-[var(--text-primary)]">
          Add to day — {selection.date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
        </div>
        <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
          Empty day space opens the add-to-day dialog: commitment · timetable block · blocker.
        </div>
      </div>
    );
  }
  const t = selection.track;
  const rows = [
    { label: "Goal", glyph: "◎", value: t.kind === "goal" ? t.title : t.goalTitle, show: true },
    { label: "Milestone", glyph: "◆", value: t.kind === "milestone" ? t.title : t.milestoneTitle, show: t.kind !== "goal" },
    { label: "Task", glyph: "○", value: t.kind === "task" ? t.title : null, show: t.kind === "task", hours: t.hours },
  ].filter((r) => r.show && r.value);
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3">
      <div className="text-[11px] font-semibold text-[var(--text-primary)]">Item details — task › milestone › goal</div>
      <div className="mt-1.5 space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2">
            <span className="w-16 shrink-0 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">{r.label}</span>
            <span aria-hidden="true" className="text-[10px] text-[var(--accent)]">{r.glyph}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">{r.value}</span>
            {r.hours && <span className="shrink-0 text-[9px] tabular-nums text-[var(--text-muted)]">{r.hours}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Legend() {
  const items = [
    { depth: 0, label: "Goal span" },
    { depth: 1, label: "Milestone span" },
    { depth: 2, label: "Task span" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((it) => (
        <div key={it.depth} className="flex items-center gap-1.5">
          <span className="h-3 w-6 rounded-[2px]" style={{ background: fill(it.depth), boxShadow: `inset 3px 0 0 0 ${BLUE}` }} />
          <span className="text-[10px] text-[var(--text-secondary)]">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Same segmentation as `segment`, from raw day numbers. */
function rangeSeg(startDay, endDay, week) {
  const s = at(startDay);
  const e = at(endDay);
  const weekStart = week[0];
  const weekEnd = addDays(week[6], 1);
  if (e < weekStart || s >= weekEnd) return null;
  const segStart = s < weekStart ? weekStart : s;
  const segEnd = e >= weekEnd ? addDays(week[6], 1) : addDays(e, 1);
  let startCol = 1;
  let endCol = 7;
  for (let i = 0; i < 7; i++) {
    if (week[i] >= segStart) {
      startCol = i + 1;
      break;
    }
  }
  for (let i = 6; i >= 0; i--) {
    if (week[i] < segEnd) {
      endCol = i + 1;
      break;
    }
  }
  return { startCol, endCol, opensLeft: s < weekStart, opensRight: e >= weekEnd };
}

// Box-in-box fills/borders — child sits inside parent, darker each level.
const boxStyle = (color, depth) => ({
  background: `color-mix(in srgb, ${color} ${[10, 24, 44][depth]}%, var(--bg-primary))`,
  border: `1px solid color-mix(in srgb, ${color} ${[45, 62, 80][depth]}%, transparent)`,
});

function BoxLabel({ depth, glyph, title, seg, onClick, dense = false }) {
  const labelSize = dense
    ? depth === 0
      ? "text-[8px] font-semibold leading-none"
      : "text-[7px] font-medium leading-none"
    : depth === 0
      ? "text-[10px] font-semibold leading-tight"
      : "text-[9.5px] font-medium leading-tight";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex w-full items-center gap-1 rounded-[2px] px-1 py-0 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
      style={{ color: "var(--text-primary)" }}
    >
      <span aria-hidden="true" className={`shrink-0 opacity-70 ${dense ? "text-[7px]" : "text-[9px]"}`}>
        {seg?.opensLeft ? "◂" : ""}
        {glyph}
      </span>
      <span className={`truncate ${labelSize}`}>{title}</span>
      {seg?.opensRight && <span aria-hidden="true" className={`ml-auto shrink-0 opacity-50 ${dense ? "text-[7px]" : "text-[9px]"}`}>▸</span>}
    </button>
  );
}

/**
 * Box-under-box — the goal is a bordered container; each milestone is a box
 * rendered inside it; each task is a box rendered inside its milestone. Boxes
 * are placed on the same date columns as the flat grid, so alignment survives.
 */
function NestedBoxesCalendar({ onSelectDay, onSelectTrack }) {
  const weeks = monthWeeks(at(1));
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]">
      <div className="grid grid-cols-7 border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[var(--text-muted)] select-none">
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => {
        const g = rangeSeg(GOAL.start, GOAL.end, week);
        return (
          <div
            key={wi}
            className="relative grid border-b border-[var(--border)] last:border-b-0"
            style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gridTemplateRows: "auto auto" }}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-7">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className={i === 0 ? "" : "border-l border-[var(--border)]"} />
              ))}
            </div>

            {week.map((date, ci) => {
              const inMonth = date.getMonth() === M;
              const isToday = date.toDateString() === new Date().toDateString();
              return (
                <div
                  key={ci}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectDay(date)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectDay(date);
                    }
                  }}
                  aria-label={`${date.toDateString()} — add to day`}
                  className={[
                    "relative row-start-1 cursor-pointer px-1.5 pt-1 pb-1 hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
                    inMonth ? "" : "opacity-40",
                    isToday ? "ring-1 ring-inset ring-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-primary))]" : "",
                  ].join(" ")}
                  style={{ gridColumn: ci + 1, gridRow: 1 }}
                >
                  <div className="mb-1 flex justify-end">
                    <span
                      className={[
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                        isToday ? "bg-[var(--accent)] font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]",
                      ].join(" ")}
                    >
                      {date.getDate()}
                    </span>
                  </div>
                </div>
              );
            })}

            {g && (
              <div style={{ gridColumn: `${g.startCol} / ${g.endCol + 1}`, gridRow: 2, padding: "2px 4px" }}>
                <div className="rounded-md p-1" style={boxStyle(BLUE, 0)}>
                  <BoxLabel
                    depth={0}
                    glyph="◎"
                    title={GOAL.title}
                    seg={g}
                    onClick={() => onSelectTrack({ kind: "goal", title: GOAL.title })}
                  />
                  <div
                    className="mt-0.5 grid"
                    style={{ gridTemplateColumns: `repeat(${g.endCol - g.startCol + 1}, minmax(0, 1fr))`, gap: 2 }}
                  >
                    {MILESTONES.map((m, mi) => {
                      const ms = rangeSeg(m.start, m.end, week);
                      if (!ms) return null;
                      const lc = ms.startCol - g.startCol + 1;
                      const rc = ms.endCol - g.startCol + 1;
                      return (
                        <div key={mi} style={{ gridColumn: `${lc} / ${rc + 1}` }}>
                          <div className="rounded-md p-1" style={boxStyle(BLUE, 1)}>
                            <BoxLabel
                              depth={1}
                              glyph="◆"
                              title={m.title}
                              seg={ms}
                              onClick={() => onSelectTrack({ kind: "milestone", title: m.title, goalTitle: GOAL.title })}
                            />
                            <div
                              className="mt-0.5 grid"
                              style={{ gridTemplateColumns: `repeat(${rc - lc + 1}, minmax(0, 1fr))`, gap: 2 }}
                            >
                              {m.tasks.map((t, ti) => {
                                const ts = rangeSeg(t.start, t.end, week);
                                if (!ts) return null;
                                const tlc = ts.startCol - ms.startCol + 1;
                                const trc = ts.endCol - ms.startCol + 1;
                                return (
                                  <button
                                    key={ti}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onSelectTrack({
                                        kind: "task",
                                        title: t.title,
                                        hours: t.hours,
                                        milestoneTitle: m.title,
                                        goalTitle: GOAL.title,
                                      });
                                    }}
                                    style={{ gridColumn: `${tlc} / ${trc + 1}`, ...boxStyle(BLUE, 2) }}
                                    className="flex items-center gap-1 rounded px-1.5 py-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                  >
                                    <span aria-hidden="true" className="shrink-0 text-[10px] opacity-70">○</span>
                                    <span className="truncate text-[11px] leading-tight text-[var(--text-primary)]">{t.title}</span>
                                    {t.hours && <span className="ml-auto shrink-0 text-[9px] tabular-nums opacity-70">{t.hours}</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default {
  title: "Timeline/Calendar nested spans",
  parameters: { layout: "fullscreen" },
};

export const GoalMilestoneTaskNestedBars = () => {
  const [selection, setSelection] = useState({ type: "track", track: TRACKS[3] });
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">October 2026 — nested spans</div>
          <div className="text-xs text-[var(--text-muted)]">
            One bar per range. Click a coloured bar for details; click empty day space to add.
          </div>
        </div>
        <Legend />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <NestedSpansCalendar onSelectDay={(date) => setSelection({ type: "day", date })} onSelectTrack={(track) => setSelection({ type: "track", track })} />
        <div className="space-y-3">
          <Inspector selection={selection} />
          <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            Depth darkens the fill: goal 14% → milestone 34% → task 54% of the goal colour. Each level
            insets inside its parent's date range, so containment reads without repeating a card per day.
          </div>
        </div>
      </div>
    </div>
  );
};

export const GoalMilestoneTaskNestedBoxes = () => {
  const [selection, setSelection] = useState({ type: "track", track: { kind: "task", title: "Build the 15-role target list and master resume", hours: "6h", milestoneTitle: MILESTONES[0].title, goalTitle: GOAL.title } });
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">October 2026 — box under box</div>
          <div className="text-xs text-[var(--text-muted)]">
            A box per range, nested inside its parent box. Click a box for details; click empty day space to add.
          </div>
        </div>
        <Legend />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <NestedBoxesCalendar onSelectDay={(date) => setSelection({ type: "day", date })} onSelectTrack={(track) => setSelection({ type: "track", track })} />
        <div className="space-y-3">
          <Inspector selection={selection} />
          <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            Goal box spans its dates; milestone boxes render inside it; task boxes render inside their
            milestone. Each level gets a darker fill and border. Boxes stay on the real date columns, so a
            task still lines up with the day it starts.
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Realistic load: 5 concurrent goals, each with milestones + tasks ─────────
const FIVE_GOALS = [
  {
    id: "g1", title: "Switch to a new job within 3 months", color: "#0A84FF", start: 1, end: 31,
    milestones: [
      { title: "Target list and master resume finalized", start: 2, end: 10, tasks: [
        { title: "Build target-role list", start: 2, end: 6, hours: "4h" },
        { title: "Finalize master resume", start: 7, end: 10, hours: "3h" },
      ]},
      { title: "10 tailored applications submitted", start: 14, end: 25, tasks: [
        { title: "Tailor 10 applications", start: 14, end: 20, hours: "5h" },
        { title: "Submit applications", start: 21, end: 25, hours: "2h" },
      ]},
    ],
  },
  {
    id: "g2", title: "Run a half marathon", color: "#34C759", start: 1, end: 28,
    milestones: [
      { title: "Base 5k under 30 min", start: 1, end: 14, tasks: [
        { title: "Run 5k three times", start: 1, end: 7, hours: "3h" },
        { title: "Time trial 5k", start: 8, end: 14, hours: "1h" },
      ]},
      { title: "Long run 15k", start: 15, end: 28, tasks: [
        { title: "Weekly long runs", start: 15, end: 22, hours: "4h" },
        { title: "15k long run", start: 23, end: 28, hours: "2h" },
      ]},
    ],
  },
  {
    id: "g3", title: "Ship the side-project MVP", color: "#FF9F0A", start: 5, end: 31,
    milestones: [
      { title: "Core flows working", start: 5, end: 18, tasks: [
        { title: "Build auth flow", start: 5, end: 12, hours: "6h" },
        { title: "Build checkout", start: 13, end: 18, hours: "5h" },
      ]},
      { title: "MVP shipped", start: 19, end: 31, tasks: [
        { title: "Polish and changelog", start: 19, end: 26, hours: "4h" },
        { title: "Ship to production", start: 27, end: 31, hours: "3h" },
      ]},
    ],
  },
  {
    id: "g4", title: "Learn conversational Spanish", color: "#BF5AF2", start: 1, end: 31,
    milestones: [
      { title: "Order food in Spanish", start: 1, end: 15, tasks: [
        { title: "Complete 20 lessons", start: 1, end: 10, hours: "5h" },
        { title: "Roleplay ordering", start: 11, end: 15, hours: "2h" },
      ]},
      { title: "30-minute conversation", start: 16, end: 31, tasks: [
        { title: "Weekly tutor sessions", start: 16, end: 24, hours: "4h" },
        { title: "Conversation test", start: 25, end: 31, hours: "1h" },
      ]},
    ],
  },
  {
    id: "g5", title: "Read 6 books this quarter", color: "#FF375F", start: 1, end: 31,
    milestones: [
      { title: "Books 1 and 2 finished", start: 1, end: 16, tasks: [
        { title: "Read Book 1", start: 1, end: 8, hours: "3h" },
        { title: "Read Book 2", start: 9, end: 16, hours: "3h" },
      ]},
      { title: "Book 3 finished", start: 17, end: 31, tasks: [
        { title: "Read Book 3", start: 17, end: 31, hours: "4h" },
      ]},
    ],
  },
];

function GoalLegend({ goals }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {goals.map((g) => (
        <div key={g.id} className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm" style={{ background: boxStyle(g.color, 1).background, border: boxStyle(g.color, 0).border }} />
          <span className="text-[10px] text-[var(--text-secondary)]">{g.title}</span>
        </div>
      ))}
    </div>
  );
}

/** Every goal that intersects a week stacks as its own nested box in that week. */
function MultiGoalBoxesCalendar({ goals, onSelectDay, onSelectTrack }) {
  const weeks = monthWeeks(at(1));
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]">
      <div className="grid grid-cols-7 border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[var(--text-muted)] select-none">
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => {
        const goalSegs = goals.map((g) => ({ g, seg: rangeSeg(g.start, g.end, week) })).filter((x) => x.seg);
        return (
          <div
            key={wi}
            className="relative grid border-b border-[var(--border)] last:border-b-0"
            style={{
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gridTemplateRows: `auto${goalSegs.length ? ` repeat(${goalSegs.length}, auto)` : ""}`,
            }}
          >
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-7">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className={i === 0 ? "" : "border-l border-[var(--border)]"} />
              ))}
            </div>

            {week.map((date, ci) => {
              const inMonth = date.getMonth() === M;
              const isToday = date.toDateString() === new Date().toDateString();
              return (
                <div
                  key={ci}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectDay(date)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectDay(date);
                    }
                  }}
                  aria-label={`${date.toDateString()} — add to day`}
                  className={[
                    "relative row-start-1 cursor-pointer px-1.5 pt-1 pb-1 hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
                    inMonth ? "" : "opacity-40",
                    isToday ? "ring-1 ring-inset ring-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-primary))]" : "",
                  ].join(" ")}
                  style={{ gridColumn: ci + 1, gridRow: 1 }}
                >
                  <div className="mb-0.5 flex justify-end">
                    <span
                      className={[
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums",
                        isToday ? "bg-[var(--accent)] font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]",
                      ].join(" ")}
                    >
                      {date.getDate()}
                    </span>
                  </div>
                </div>
              );
            })}

            {goalSegs.map(({ g, seg }, gi) => {
              const gSpan = seg.endCol - seg.startCol + 1;
              return (
                <div key={g.id} style={{ gridColumn: `${seg.startCol} / ${seg.endCol + 1}`, gridRow: gi + 2, padding: "0px 1px" }}>
                  <div className="rounded-md p-0" style={boxStyle(g.color, 0)}>
                    <BoxLabel
                      depth={0}
                      dense
                      glyph="◎"
                      title={g.title}
                      seg={seg}
                      onClick={() => onSelectTrack({ kind: "goal", title: g.title })}
                    />
                    <div className="mt-0 grid" style={{ gridTemplateColumns: `repeat(${gSpan}, minmax(0, 1fr))`, gap: 1 }}>
                      {g.milestones.map((m, mi) => {
                        const ms = rangeSeg(m.start, m.end, week);
                        if (!ms) return null;
                        const lc = ms.startCol - seg.startCol + 1;
                        const rc = ms.endCol - seg.startCol + 1;
                        return (
                          <div key={mi} style={{ gridColumn: `${lc} / ${rc + 1}` }}>
                            <div className="rounded-md p-0" style={boxStyle(g.color, 1)}>
                              <BoxLabel
                                depth={1}
                                dense
                                glyph="◆"
                                title={m.title}
                                seg={ms}
                                onClick={() => onSelectTrack({ kind: "milestone", title: m.title, goalTitle: g.title })}
                              />
                              <div className="mt-0 grid" style={{ gridTemplateColumns: `repeat(${rc - lc + 1}, minmax(0, 1fr))`, gap: 1 }}>
                                {m.tasks.map((t, ti) => {
                                  const ts = rangeSeg(t.start, t.end, week);
                                  if (!ts) return null;
                                  const tlc = ts.startCol - ms.startCol + 1;
                                  const trc = ts.endCol - ms.startCol + 1;
                                  return (
                                    <button
                                      key={ti}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onSelectTrack({
                                          kind: "task",
                                          title: t.title,
                                          hours: t.hours,
                                          milestoneTitle: m.title,
                                          goalTitle: g.title,
                                        });
                                      }}
                                      style={{ gridColumn: `${tlc} / ${trc + 1}`, ...boxStyle(g.color, 2) }}
                                      className="flex items-center gap-0.5 rounded px-0.5 py-0 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                    >
                                      <span aria-hidden="true" className="shrink-0 text-[7px] opacity-70">○</span>
                                      <span className="truncate text-[8px] leading-none text-[var(--text-primary)]">{t.title}</span>
                                      {t.hours && <span className="ml-auto shrink-0 text-[7px] tabular-nums opacity-70">{t.hours}</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function FiveGoalsDemo() {
  const g = FIVE_GOALS[0];
  const [selection, setSelection] = useState({
    type: "track",
    track: { kind: "task", title: g.milestones[0].tasks[0].title, hours: g.milestones[0].tasks[0].hours, milestoneTitle: g.milestones[0].title, goalTitle: g.title },
  });
  return (
    <div className="min-h-screen bg-[var(--bg-primary)] p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            October 2026 — 5 concurrent goals (box under box)
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            Five active goals. Tight padding and 7–8px labels keep the stack short; click any box for details.
          </div>
        </div>
        <GoalLegend goals={FIVE_GOALS} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <MultiGoalBoxesCalendar
          goals={FIVE_GOALS}
          onSelectDay={(date) => setSelection({ type: "day", date })}
          onSelectTrack={(track) => setSelection({ type: "track", track })}
        />
        <div className="space-y-3">
          <Inspector selection={selection} />
          <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            Each week stacks one box per goal that overlaps it. Zero padding, 1px gaps and 7–8px labels keep
            five goals compact; the goal colour, not a repeated card, carries identity.
          </div>
        </div>
      </div>
    </div>
  );
}

export const FiveGoalsRealistic = () => <FiveGoalsDemo />;

// ── Continuous spans + goal multi-select filter ──────────────────────────────
// Continuous spans, nested. Month/quarter use WEEK columns (no 7-day wrap, so a
// goal, its milestones and its weekly tasks each sit in one unbroken box); year
// uses MONTH columns. There is no left label sidebar — every box carries its
// own title, and the goal box contains its milestone boxes which contain their
// weekly task boxes.

const TODAY_DAY = 5; // Mon Oct 5, 2026

// All 31 days stay as columns (the current layout). Tasks shown here are WEEKLY,
// not daily, so each task bar is snapped to its Mon–Sun week and clamped inside
// its milestone. The goal box holds its milestone boxes, which hold the weekly
// task boxes — and there is no left label sidebar.
const OCT_DAYS = 31;
const DAY_COLUMNS = Array.from({ length: OCT_DAYS }, (_, i) => ({
  key: `d${i + 1}`,
  day: i + 1,
  weekday: WEEKDAYS[(at(i + 1).getDay() + 6) % 7][0],
}));
const WEEK_RANGES = [[1, 4], [5, 11], [12, 18], [19, 25], [26, 31]];
const weekOf = (day) => WEEK_RANGES.findIndex(([s, e]) => day >= s && day <= e);
// Vertical column lines drawn IN FRONT of the boxes but BEHIND the text. Monday's
// week-boundary line is one shade darker than the other weekdays (same 1px).
const isWeekendDay = (day) => [0, 6].includes(at(day).getDay());
const isMonday = (day) => at(day).getDay() === 1;
const colLine = (day) =>
  day === 1
    ? ""
    : isMonday(day)
      ? "border-l border-[var(--border-accent)]"
      : "border-l border-[color-mix(in_srgb,var(--border)_60%,transparent)]";

/** Snap each task to whole weeks, clamped inside its milestone. */
function weeklyTasks(milestone) {
  return milestone.tasks.map((t) => {
    const start = Math.max(WEEK_RANGES[weekOf(t.start)][0], milestone.start);
    const end = Math.min(WEEK_RANGES[weekOf(t.end)][1], milestone.end);
    return { ...t, start, end };
  });
}

function GoalFilter({ goals, selected, onToggle, onAll }) {
  const allOn = selected.size === goals.length;
  return (
    <div role="group" aria-label="Choose which goals to show" className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible">
      <button
        type="button"
        onClick={onAll}
        aria-pressed={allOn}
        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${allOn ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_16%,var(--bg-primary))] text-[var(--text-primary)]" : "border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"}`}
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
            className={`flex max-w-[200px] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed ${on ? "text-[var(--text-primary)]" : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}
            style={on ? { background: `color-mix(in srgb, ${g.color} 20%, var(--bg-primary))`, borderColor: `color-mix(in srgb, ${g.color} 55%, transparent)` } : undefined}
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

function NestedColumns({ goals, selected, onSelectDay, onSelectTrack, forceScroll = false }) {
  const rows = goals.filter((g) => selected.has(g.id));
  const n = OCT_DAYS;
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]">
      <div className={forceScroll ? "min-w-[680px]" : "min-w-[680px] sm:min-w-0"}>
        {/* day header — clicking a day adds to it */}
        <div className="grid border-b border-[var(--border-accent)]" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {DAY_COLUMNS.map((c) => {
            const isToday = c.day === TODAY_DAY;
            const isWeekend = [0, 6].includes(at(c.day).getDay());
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => onSelectDay(at(c.day))}
                aria-label={`Add on October ${c.day}`}
                className={`flex flex-col items-center py-0.5 leading-none hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] ${colLine(c.day)} ${isWeekend ? "bg-[color-mix(in_srgb,var(--text-muted)_6%,transparent)]" : ""}`}
              >
                <span className="text-[8px] text-[var(--text-muted)]">{c.weekday}</span>
                <span className={`mt-0.5 text-[10px] tabular-nums ${isToday ? "rounded-full bg-[var(--accent)] px-1 font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]"}`}>{c.day}</span>
              </button>
            );
          })}
        </div>

        {/* One row per goal. The goal box spans its days and contains its
            milestone boxes, which contain their weekly task boxes. Background
            day cells keep empty space clickable (add to day). */}
        <div
          className="relative grid"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.max(rows.length, 1)}, auto)` }}
        >
          {rows.length === 0 ? (
            <div className="col-span-full px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">Select at least one goal.</div>
          ) : (
            <>
              {rows.map((g, gi) =>
                DAY_COLUMNS.map((c, ci) => (
                  <button
                    key={`bg-${g.id}-${c.day}`}
                    type="button"
                    onClick={() => onSelectDay(at(c.day))}
                    aria-label={`Add on October ${c.day}`}
                    style={{ gridColumn: ci + 1, gridRow: gi + 1 }}
                    className={`hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] ${c.day === TODAY_DAY ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg-primary))]" : ""}`}
                  />
                )),
              )}

              {/* vertical-line overlay drawn IN FRONT of the boxes */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-20 grid"
                style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
              >
                {DAY_COLUMNS.map((c) => (
                  <div
                    key={c.key}
                    className={`${colLine(c.day)} ${isWeekendDay(c.day) ? "bg-[color-mix(in_srgb,var(--text-muted)_6%,transparent)]" : ""}`}
                  />
                ))}
              </div>

              {rows.map((g, gi) => {
                const gSpan = g.end - g.start + 1;
                return (
                  <div key={g.id} style={{ gridColumn: `${g.start} / ${g.end + 1}`, gridRow: gi + 1 }} className="p-1">
                    <div className="rounded-md p-1" style={boxStyle(g.color, 0)}>
                      <button
                        type="button"
                        onClick={() => onSelectTrack({ kind: "goal", title: g.title, color: g.color })}
                        className="flex w-full items-center gap-1 rounded-[2px] px-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                      >
                        <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] opacity-70">◎</span>
                        <span className="relative z-30 min-w-0 truncate text-[10px] font-bold text-[var(--text-primary)]">{g.title}</span>
                      </button>

                      <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${gSpan}, minmax(0, 1fr))`, gap: 2 }}>
                        {g.milestones.map((m, mi) => {
                          const lc = m.start - g.start + 1;
                          const rc = m.end - g.start + 1;
                          const mSpan = rc - lc + 1;
                          const tasks = weeklyTasks(m);
                          return (
                            <div key={mi} style={{ gridColumn: `${lc} / ${rc + 1}` }}>
                              <div className="rounded-md p-1" style={boxStyle(g.color, 1)}>
                                <button
                                  type="button"
                                  onClick={() => onSelectTrack({ kind: "milestone", title: m.title, goalTitle: g.title, color: g.color })}
                                  className="flex w-full items-center gap-1 rounded-[2px] px-1 text-left hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
                                >
                                  <span aria-hidden="true" className="relative z-30 shrink-0 text-[9px] opacity-70">◆</span>
                                  <span className="relative z-30 min-w-0 truncate text-[9px] font-semibold text-[var(--text-primary)]">{m.title}</span>
                                </button>

                                <div className="mt-0.5 grid" style={{ gridTemplateColumns: `repeat(${mSpan}, minmax(0, 1fr))`, gap: 2 }}>
                                  {tasks.map((t, ti) => {
                                    const tlc = Math.max(1, t.start - m.start + 1);
                                    const trc = Math.min(mSpan, t.end - m.start + 1);
                                    if (trc < tlc) return null;
                                    return (
                                      <button
                                        key={ti}
                                        type="button"
                                        onClick={() =>
                                          onSelectTrack({ kind: "task", title: t.title, hours: t.hours, milestoneTitle: m.title, goalTitle: g.title, color: g.color })
                                        }
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

function ContinuousSpansDemo({ forceScroll = false }) {
  const [selected, setSelected] = useState(() => new Set(FIVE_GOALS.map((g) => g.id)));
  const [selection, setSelection] = useState({ type: "day", date: at(TODAY_DAY) });

  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size === 1) return prev; // never below one
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  return (
    <div className="min-h-screen bg-[var(--bg-primary)] p-5">
      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">October 2026 — nested boxes</div>
            <div className="text-xs text-[var(--text-muted)]">
              All days as columns, no sidebar. The goal box holds its milestone boxes, which hold the weekly task boxes.
            </div>
          </div>
          <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
            Showing {selected.size} of {FIVE_GOALS.length} goals
          </span>
        </div>
        <GoalFilter
          goals={FIVE_GOALS}
          selected={selected}
          onToggle={toggle}
          onAll={() => setSelected(new Set(FIVE_GOALS.map((g) => g.id)))}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <NestedColumns
          goals={FIVE_GOALS}
          selected={selected}
          forceScroll={forceScroll}
          onSelectDay={(date) => setSelection({ type: "day", date })}
          onSelectTrack={(row) => setSelection({ type: "track", track: row })}
        />
        <div className="space-y-3">
          <Inspector selection={selection} />
          <div className="rounded-lg border border-dashed border-[var(--border)] p-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
            Goal box ▸ milestone box ▸ weekly task box, nested, with no label column — a task bar spans its
            whole week, so it never breaks. Multi-select keeps at least one goal on screen.
          </div>
        </div>
      </div>
    </div>
  );
}

export const ContinuousSpansWithGoalFilter = () => <ContinuousSpansDemo />;

export const ContinuousSpansMobile = () => (
  <div className="min-h-screen bg-[var(--bg-secondary)] p-4">
    <div className="mx-auto w-[390px] overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--bg-primary)] shadow-xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
        <span>9:41</span>
        <span className="font-medium text-[var(--text-secondary)]">Goal calendar</span>
        <span aria-hidden="true">●●●</span>
      </div>
      <ContinuousSpansDemo forceScroll />
    </div>
    <p className="mx-auto mt-3 w-[390px] text-[10px] leading-relaxed text-[var(--text-muted)]">
      Mobile: goal chips scroll in one row, the day columns scroll sideways, and the details panel stacks below.
    </p>
  </div>
);;
