import React, { Fragment } from "react";
import { CalendarCard } from "./CalendarCards";

/**
 * HourGrid — Google-Calendar-style time grid for the Day/Week spans.
 *
 * Shown only when the user has planned timetable blocks. All-day items
 * (tasks/milestones) sit in an all-day row on top; the user's
 * timeblocks are placed in their day/hour column. Clicking an empty slot
 * opens the add dialog for that day.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtHour = (h) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? " AM" : " PM"}`;
const toMin = (t) => {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

const ROW_PX = 40;

export function HourGrid({ days, blocks, cards, onSelectItem, onSelectSlot }) {
  const HOURS = Array.from({ length: 24 }, (_, h) => h);
  const blocksByDay = new Map();
  (blocks || []).forEach((b) => {
    const a = blocksByDay.get(b.block_date) || [];
    a.push(b);
    blocksByDay.set(b.block_date, a);
  });
  const cardsByDay = new Map();
  (cards || []).forEach((c) => {
    if (!c.date) return;
    const k = iso(c.date);
    const a = cardsByDay.get(k) || [];
    a.push(c);
    cardsByDay.set(k, a);
  });

  return (
    <div className="max-h-[72vh] overflow-auto rounded-lg border border-[var(--border)]">
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div className="sticky top-0 z-10 h-8 border-b border-r border-[var(--border)] bg-[var(--bg-primary)]" />
        {days.map((d) => (
          <div
            key={iso(d)}
            className="sticky top-0 z-10 h-8 border-b border-l border-[var(--border)] bg-[var(--bg-primary)] px-2 text-center text-[11px] font-medium text-[var(--text-primary)]"
          >
            {WEEKDAYS[d.getDay()]} {d.getDate()}
          </div>
        ))}

        {/* all-day row */}
        <div className="border-b border-r border-[var(--border)] px-1 py-1 text-right text-[9px] text-[var(--text-muted)]">
          all-day
        </div>
        {days.map((d) => (
          <div
            key={`ad-${iso(d)}`}
            onClick={() => onSelectSlot?.(d, null)}
            className="min-h-8 cursor-pointer space-y-1 border-b border-l border-[var(--border)] p-1"
          >
            {(cardsByDay.get(iso(d)) || []).map((c) => (
              <CalendarCard
                key={c.id}
                card={c}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectItem?.(c.item);
                }}
              />
            ))}
          </div>
        ))}

        {/* hour rows */}
        {HOURS.map((h) => (
          <Fragment key={h}>
            <div className="h-10 border-b border-r border-[var(--border)] pr-1 text-right text-[9px] leading-10 text-[var(--text-muted)]">
              {fmtHour(h)}
            </div>
            {days.map((d) => {
              const dayBlocks = blocksByDay.get(iso(d)) || [];
              const starting = dayBlocks.filter((b) => {
                const s = toMin(b.start_time);
                return s >= h * 60 && s < (h + 1) * 60;
              });
              return (
                <div
                  key={`${iso(d)}-${h}`}
                  onClick={() => onSelectSlot?.(d, h)}
                  className="relative h-10 cursor-pointer border-b border-l border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
                >
                  {starting.map((b) => {
                    const start = toMin(b.start_time);
                    const end = toMin(b.end_time);
                    const top = ((start - h * 60) / 60) * ROW_PX;
                    const height = Math.max(18, ((end - start) / 60) * ROW_PX);
                    return (
                      <button
                        key={b.id}
                        type="button"
                        onClick={(e) => e.stopPropagation()}
                        style={{ top, height }}
                        className="absolute inset-x-0.5 overflow-hidden rounded bg-[color-mix(in_srgb,var(--accent)_22%,var(--bg-primary))] px-1 text-left text-[10px] text-[var(--text-primary)]"
                      >
                        <span className="block truncate font-medium">{b.label}</span>
                        <span className="block truncate text-[9px] text-[var(--text-muted)]">
                          {b.start_time}–{b.end_time}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export { WEEKDAYS };
