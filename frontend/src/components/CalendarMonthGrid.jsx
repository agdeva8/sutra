import React from "react";
import { CalendarCard } from "./CalendarCards";

/**
 * CalendarMonthGrid — the Timeline month view.
 *
 * Single-day items render as the existing Option C breadcrumb card (goals
 * stay out — they're context, not cards). ONLY items that genuinely span
 * more than one day — a blocker across a trip, a multi-day task — draw one
 * continuous bar across the columns they cover. That keeps the grid
 * stable: no long goal-range bars stretching across the whole month.
 *
 * `cards` are pre-enriched by the caller (id, item{start,end,kind,status},
 * date, glyph, title, goalTitle, color, fulfils, hours) — the same shape
 * `calendarCards` already builds for the card grid.
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
const startOfWeek = (d) => {
  const x = startOfDay(d);
  const day = x.getDay();
  x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
  return x;
};
const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? new Date(v) : new Date(`${String(v).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : startOfDay(d);
};

function monthWeeks(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const weeks = [];
  for (let cur = start; cur <= end; cur = addDays(cur, 7)) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(cur, i);
      week.push({ date, inMonth: date.getMonth() === anchor.getMonth() });
    }
    weeks.push(week);
  }
  return weeks;
}

/** Split a week's cards into single-day (per day) and multi-day (tracks). */
function splitWeek(week, cards) {
  const weekStart = week[0].date;
  const weekEnd = addDays(week[6].date, 1);
  const singlesByDay = new Map();
  const multi = [];
  for (const c of cards) {
    const s = asDate(c.item?.start || c.date);
    const e = asDate(c.item?.end || c.date) || s;
    if (!s || !e) continue;
    if (e > s) {
      if (e < weekStart || s >= weekEnd) continue;
      const segStart = s < weekStart ? weekStart : s;
      const segEnd = e >= weekEnd ? addDays(week[6].date, 1) : addDays(e, 1);
      let startCol = 1;
      let endCol = 7;
      for (let i = 0; i < 7; i++) {
        if (week[i].date >= segStart) {
          startCol = i + 1;
          break;
        }
      }
      for (let i = 6; i >= 0; i--) {
        if (week[i].date < segEnd) {
          endCol = i + 1;
          break;
        }
      }
      multi.push({ card: c, startCol, endCol, lane: -1, opensLeft: s < weekStart, opensRight: e >= weekEnd });
    } else {
      const key = s.getTime();
      const arr = singlesByDay.get(key) || [];
      arr.push(c);
      singlesByDay.set(key, arr);
    }
  }
  // Greedy lane pack — only the multi-day bars occupy lanes, so the day
  // row keeps its height and the grid never grows an empty band.
  multi.sort((a, b) =>
    a.startCol !== b.startCol
      ? a.startCol - b.startCol
      : b.endCol - b.startCol - (a.endCol - a.startCol),
  );
  const laneEnds = [];
  multi.forEach((t) => {
    let placed = false;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] < t.startCol) {
        laneEnds[i] = t.endCol;
        t.lane = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      t.lane = laneEnds.length;
      laneEnds.push(t.endCol);
    }
  });
  return { singlesByDay, multi, lanes: laneEnds.length };
}

function SpanBar({ track, onSelectItem }) {
  const { card } = track;
  return (
    <button
      type="button"
      data-testid={`month-bar-${card.item?.kind || "item"}-${card.id}-${track.startCol}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelectItem?.(card.item);
      }}
      aria-label={card.title}
      className="flex h-7 w-full items-center gap-1.5 overflow-hidden rounded-[3px] px-2 text-left text-[11px] font-medium text-[var(--text-primary)] transition-[filter] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
      style={{
        background: `color-mix(in srgb, ${card.color} 16%, var(--bg-primary))`,
        boxShadow: `inset 3px 0 0 0 ${card.color}`,
      }}
    >
      <span aria-hidden="true" className="shrink-0">
        {track.opensLeft ? "◂ " : ""}
        {card.glyph || ""}
      </span>
      <span className="truncate">{card.title}</span>
      {track.opensRight && (
        <span aria-hidden="true" className="ml-auto shrink-0 opacity-50">
          ▸
        </span>
      )}
    </button>
  );
}

export default function CalendarMonthGrid({
  anchor = new Date(),
  cards = [],
  today = new Date(),
  onSelectItem,
  onSelectDay,
}) {
  const weeks = monthWeeks(anchor);
  const todayKey = startOfDay(today).getTime();

  return (
    <div
      data-testid="calendar-month-grid"
      className="overflow-hidden rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]"
    >
      <div className="grid grid-cols-7 border-b border-[var(--border-accent)] bg-[color-mix(in_srgb,var(--bg-secondary)_40%,transparent)]">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-2 text-center text-[11px] font-medium text-[var(--text-muted)] select-none">
            {d}
          </div>
        ))}
      </div>

      {weeks.map((week, wi) => {
        const { singlesByDay, multi, lanes } = splitWeek(week, cards);
        return (
          <div
            key={wi}
            className="relative grid border-b border-[var(--border)] last:border-b-0"
            style={{
              gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
              gridTemplateRows: `auto${lanes ? ` repeat(${lanes}, 32px)` : ""}`,
            }}
          >
            {/* Full-height column guides so the days read as columns even
                under a spanning bar — the bar paints over them. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 grid grid-cols-7">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className={i === 0 ? "" : "border-l border-[var(--border)]"} />
              ))}
            </div>

            {week.map((cell, ci) => {
              const isToday = startOfDay(cell.date).getTime() === todayKey;
              const dayCards = singlesByDay.get(startOfDay(cell.date).getTime()) || [];
              return (
                <div
                  key={ci}
                  role={onSelectDay ? "button" : undefined}
                  tabIndex={onSelectDay ? 0 : undefined}
                  onClick={onSelectDay ? () => onSelectDay(cell.date) : undefined}
                  onKeyDown={
                    onSelectDay
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectDay(cell.date);
                          }
                        }
                      : undefined
                  }
                  aria-label={`${cell.date.toDateString()}${onSelectDay ? " — open day" : ""}`}
                  className={[
                    "relative min-h-[96px] px-1.5 pt-1 pb-1",
                    cell.inMonth ? "" : "opacity-55",
                    onSelectDay
                      ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                      : "",
                    isToday
                      ? "ring-1 ring-inset ring-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-primary))]"
                      : "",
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
                      {cell.date.getDate()}
                    </span>
                  </div>
                  {dayCards.length > 0 && (
                    <div className="space-y-1">
                      {dayCards.map((c) => (
                        <CalendarCard key={c.id} card={c} onClick={() => onSelectItem?.(c.item)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {multi.map((t) => (
              <div
                key={`${t.card.id}-${t.startCol}`}
                style={{
                  gridColumn: `${t.startCol} / ${t.endCol + 1}`,
                  gridRow: t.lane + 2,
                  padding: "2px 4px",
                }}
              >
                <SpanBar track={t} onSelectItem={onSelectItem} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
