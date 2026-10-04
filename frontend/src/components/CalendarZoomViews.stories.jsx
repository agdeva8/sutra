import React from "react";
import { TargetGrid, CardsGrid, CalendarCard, MonthGrid } from "./CalendarCards";
import { HourGrid } from "./CalendarHourGrid";

/**
 * Calendar zoom views — 3-months (weekly targets), year (monthly milestones),
 * and the day/week hour grid. Mock data so the layouts can be compared and
 * chosen before wiring more into Timeline.
 */

const BLUE = "#0A84FF";
const GREEN = "#34C759";

const GOAL = "Switch to a new job in 3 months";

// ── 3-month weekly targets ────────────────────────────────────────────────
const WEEKLY = [
  { id: "w1", title: "Week 1 — Target role list and gap-to-plan sheet", phase: "Foundations", when: "Oct 5 – Oct 11", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w2", title: "Week 2 — Target role list and gap-to-plan sheet", phase: "Foundations", when: "Oct 12 – Oct 18", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w3", title: "Week 3 — System design framework written", phase: "Foundations", when: "Oct 19 – Oct 25", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w4", title: "Week 1 — 5 timed system design mocks passed", phase: "Practice", when: "Oct 31 – Nov 6", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w5", title: "Week 2 — 5 timed system design mocks passed", phase: "Practice", when: "Nov 7 – Nov 13", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w6", title: "Week 3 — 5 recorded behavioral mocks", phase: "Practice", when: "Nov 14 – Nov 20", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w7", title: "Week 1 — 20 tailored applications submitted", phase: "Apply", when: "Nov 25 – Dec 1", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w8", title: "Week 2 — 20 tailored applications submitted", phase: "Apply", when: "Dec 2 – Dec 8", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w9", title: "Week 3 — 8 first-round interviews completed", phase: "Apply", when: "Dec 9 – Dec 15", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w10", title: "Week 1 — 3 final rounds reached", phase: "Close", when: "Dec 21 – Dec 27", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w11", title: "Week 2 — 3 final rounds reached", phase: "Close", when: "Dec 28 – Jan 3", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
  { id: "w12", title: "Week 3 — offer accepted", phase: "Close", when: "Jan 4 – Jan 10", hours: "15h/wk", color: BLUE, goalTitle: GOAL },
];

// ── year monthly milestones ───────────────────────────────────────────────
const MONTHLY = [
  { id: "m1", title: "Target role list and gap-to-plan sheet", phase: "Foundations", when: "Oct 12", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m2", title: "System design framework validated on 2 problems", phase: "Foundations", when: "Oct 19", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m3", title: "Behavioral story bank (6 stories) drafted", phase: "Foundations", when: "Oct 26", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m4", title: "5 timed system design mocks passed", phase: "Practice", when: "Nov 10", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m5", title: "5 recorded behavioral mocks completed", phase: "Practice", when: "Nov 20", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m6", title: "20 tailored applications submitted", phase: "Apply", when: "Dec 6", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m7", title: "8 first-round interviews completed", phase: "Apply", when: "Dec 16", color: BLUE, goalTitle: GOAL, glyph: "◆" },
  { id: "m8", title: "3 final rounds reached; offer accepted", phase: "Close", when: "Jan 10", color: BLUE, goalTitle: GOAL, glyph: "◆" },
];

// ── hour grid mocks ───────────────────────────────────────────────────────
const dayAt = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
};
const weekDays = [0, 1, 2, 3, 4, 5, 6].map(dayAt);
const blocks = [
  { id: "b1", block_date: shortIso(weekDays[1]), start_time: "06:00", end_time: "07:30", label: "System design study" },
  { id: "b2", block_date: shortIso(weekDays[1]), start_time: "20:00", end_time: "21:00", label: "Behavioral drills" },
  { id: "b3", block_date: shortIso(weekDays[2]), start_time: "09:00", end_time: "10:00", label: "Applications" },
  { id: "b4", block_date: shortIso(weekDays[3]), start_time: "07:00", end_time: "09:00", label: "Mock interview" },
];
function shortIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const cards = [
  { id: "t1", date: weekDays[1], glyph: "○", title: "SD framework review", color: BLUE, goalTitle: GOAL, fulfils: "System design framework written", hours: "2.1h", item: { kind: "plan" } },
  { id: "t2", date: weekDays[3], glyph: "○", title: "Mock interview #3", color: BLUE, goalTitle: GOAL, fulfils: "5 mocks passed", hours: "2.1h", item: { kind: "plan" } },
  { id: "t3", date: weekDays[1], glyph: "⚑", title: "Block 15h/week in calendar", color: GREEN, goalTitle: "Ship side-project MVP", item: { kind: "plan" } },
];

function Frame({ label, desc, children }) {
  return (
    <div className="space-y-3 bg-[var(--bg-primary)] p-4">
      <div>
        <div className="text-sm font-semibold text-[var(--text-primary)]">{label}</div>
        <div className="text-xs text-[var(--text-muted)]">{desc}</div>
      </div>
      {children}
    </div>
  );
}

export default { title: "Timeline/Calendar zoom views", parameters: { layout: "fullscreen" } };

export const ThreeMonths_WeeklyTargets_Grid = () => (
  <Frame label="3 Months — weekly targets (card grid)" desc="Current implementation: one card per plan week, responsive grid.">
    <h3 className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">Weekly targets</h3>
    <TargetGrid items={WEEKLY} />
  </Frame>
);

export const ThreeMonths_WeeklyTargets_CalendarGrid = () => (
  <Frame label="3 Months — weeks as a calendar grid" desc="Alternative: weeks laid out as grid cells with a week label + item count (like a month grid but unit = week).">
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {WEEKLY.map((w) => (
        <div key={w.id} className="rounded-lg border border-[var(--border)] p-2">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-semibold text-[var(--text-primary)]">{w.title.split(" — ")[0]}</span>
            <span className="text-[10px] tabular-nums text-[var(--text-muted)]">{w.hours}</span>
          </div>
          <div className="mb-1 text-[10px] text-[var(--text-muted)]">{w.when} · {w.phase}</div>
          <CalendarCard card={{ ...w, glyph: "▤" }} />
        </div>
      ))}
    </div>
  </Frame>
);

export const Year_MonthlyMilestones = () => (
  <Frame label="Year — Jan … Dec grid" desc="12 month cells; each lists the milestones due that month.">
    <MonthGrid
      year={new Date().getFullYear()}
      cards={MONTHLY.map((m) => ({ ...m, date: new Date(`${m.when} ${new Date().getFullYear()}`), glyph: "◆" }))}
      onSelectItem={() => {}}
    />
  </Frame>
);

export const Week_HourGrid = () => (
  <Frame label="Week — hour grid (timetable planned)" desc="Google-Calendar style: all-day row + 24h × 7 columns with blocks placed by time. Clicking a slot adds.">
    <HourGrid days={weekDays} blocks={blocks} cards={cards} onSelectItem={() => {}} onSelectSlot={() => {}} />
  </Frame>
);

export const Day_Cards = () => (
  <Frame label="Week — day cards (no timetable)" desc="Fallback when no blocks are planned: 7 columns of Option-C cards.">
    <CardsGrid days={weekDays} cards={cards} onSelectItem={() => {}} onSelectDay={() => {}} />
  </Frame>
);
