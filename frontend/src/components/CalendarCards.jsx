import React, { Fragment } from "react";

/**
 * Calendar card grid — Option C presentation.
 *
 * Each item is a breadcrumb card:
 *   line 1  the task / milestone (○ / ◆)
 *   line 2  "<goal> › fulfils <milestone> · <hours>"
 * A left stripe carries the goal colour.
 *
 * `cards` are pre-enriched by the caller (goal title/colour, fulfils, hours)
 * so this stays presentational.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function CalendarCard({ card, onClick }) {
  // A card click must never double as its container's click. Day cells wrap
  // cards and open the day planner on click, so without stopPropagation a
  // card tap opened both the item details AND the day dialog.
  return (
    <button
      type="button"
      data-testid={`cal-card-${card.id}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      aria-label={`${card.title}${card.goalTitle ? `, ${card.goalTitle}` : ""}`}
      className="w-full text-left rounded px-1.5 py-1 transition-[filter] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
      style={{
        borderLeft: `3px solid ${card.color}`,
        // Very light wash of the goal colour (theme-aware: mixes toward the
        // page background so it stays subtle in both light and dark).
        background: `color-mix(in srgb, ${card.color} 13%, var(--bg-primary))`,
      }}
    >
      <div className={`truncate text-[11px] leading-tight ${card.status === "done" ? "line-through text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
        <span aria-hidden="true">{card.glyph} </span>
        {card.title}
      </div>
      {(card.goalTitle || card.fulfils || card.hours) && (
        <div className="truncate text-[9px] leading-tight text-[var(--text-muted)]">
          {card.goalTitle}
          {card.fulfils ? ` › fulfils ${card.fulfils}` : ""}
          {card.hours ? ` · ${card.hours}` : ""}
        </div>
      )}
    </button>
  );
}

export function CardsGrid({ days, cards, onSelectItem, onSelectDay, minHeight = 150, columns }) {
  const byDay = new Map();
  for (const c of cards) {
    if (!c.date) continue;
    const k = iso(c.date);
    const arr = byDay.get(k) || [];
    arr.push(c);
    byDay.set(k, arr);
  }
  return (
    <div
      className="grid gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)]"
      style={{ gridTemplateColumns: `repeat(${columns || 7}, minmax(0, 1fr))` }}
    >
      {(days || []).map((d, i) => {
        const k = iso(d);
        const list = byDay.get(k) || [];
        const cellToday = k === iso(new Date());
        return (
          <div
            key={`${k}-${i}`}
            onClick={() => onSelectDay?.(d)}
            role={onSelectDay ? "button" : undefined}
            tabIndex={onSelectDay ? 0 : undefined}
            onKeyDown={
              onSelectDay
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectDay(d);
                    }
                  }
                : undefined
            }
            aria-label={`${d.getDate()} — add or view`}
            className={`p-1.5 ${
              cellToday
                ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg-primary))]"
                : "bg-[var(--bg-primary)]"
            } ${onSelectDay ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--accent)_6%,var(--bg-primary))]" : ""}`}
            style={{ minHeight }}
          >
            {(() => {
              const isToday = iso(d) === iso(new Date());
              return (
                <div className="mb-1 flex w-full items-baseline justify-between">
                  <span
                    className={`font-mono text-[10px] ${isToday ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}`}
                  >
                    {WEEKDAYS[d.getDay()]}
                  </span>
                  <span
                    className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold tabular-nums ${
                      isToday ? "bg-[var(--accent)] text-[var(--bg-primary)]" : "font-normal text-[var(--text-secondary)]"
                    }`}
                  >
                    {d.getDate()}
                  </span>
                </div>
              );
            })()}
            <div className="space-y-1">
              {list.map((c) => (
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
          </div>
        );
      })}
    </div>
  );
}

export function WeekdayHeader() {
  return (
    <div className="grid grid-cols-7 gap-px">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
        <div key={d} className="px-1.5 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
          {d}
        </div>
      ))}
    </div>
  );
}

/**
 * PeriodList — grouped cards for the zoomed-out spans.
 *   quarter → one block per WEEK (smallest unit = week)
 *   year    → one block per MONTH (smallest unit = month)
 */
export function PeriodList({ periods, cards, onSelectItem }) {
  const itemsIn = (s, e) =>
    cards.filter((c) => c.date && c.date >= s && c.date <= e);
  return (
    <div className="space-y-3">
      {periods.map((p) => {
        const list = itemsIn(p.start, p.end);
        return (
          <div key={p.key} data-testid={`period-${p.key}`} className="rounded-lg border border-[var(--border)] p-2">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-[var(--text-primary)]">{p.label}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">
                {list.length} item{list.length === 1 ? "" : "s"}
              </span>
            </div>
            {list.length === 0 ? (
              <div className="text-[10px] text-[var(--text-muted)]">—</div>
            ) : (
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((c) => (
                  <CalendarCard key={c.id} card={c} onClick={() => onSelectItem?.(c.item)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A plan target (a weekly or monthly `plan_items` row) as a card. */
export function TargetCard({ target, onClick }) {
  return (
    <button
      type="button"
      data-testid={`target-${target.id}`}
      onClick={onClick}
      aria-label={target.title}
      className="w-full text-left rounded px-2 py-1.5 transition-[filter] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
      style={{
        borderLeft: `3px solid ${target.color}`,
        background: `color-mix(in srgb, ${target.color} 13%, var(--bg-primary))`,
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 break-words text-[12px] font-medium leading-snug text-[var(--text-primary)]">
          <span aria-hidden="true">{target.glyph} </span>
          {target.title}
        </span>
        {target.hours ? (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{target.hours}</span>
        ) : null}
      </div>
      <div className="text-[10px] leading-tight text-[var(--text-muted)] break-words">
        {target.goalTitle}
        {target.when ? ` · ${target.when}` : ""}
      </div>
    </button>
  );
}

export function TargetGrid({ items, onSelectItem, emptyLabel = "No targets yet." }) {
  if (!items || items.length === 0) {
    return <p className="text-[11px] text-[var(--text-muted)]">{emptyLabel}</p>;
  }
  return (
    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((t) => (
        <TargetCard key={t.id} target={t} onClick={() => onSelectItem?.(t.item)} />
      ))}
    </div>
  );
}

/**
 * 3-month view — one ROW per month, one COLUMN per week. A week is a
 * Monday-anchored band **whose Monday falls inside that month**, numbered from
 * Week 1 in every month row. So November 2026 (Mondays 2, 9, 16, 23, 30) reads
 * Week 1 = Nov 2, and a month with four Mondays shows exactly four columns. A
 * cell's heading carries its own date range; empty weeks render empty.
 */
export function WeekGrid({ items, onSelectItem, start, end }) {
  const list = Array.isArray(items) ? items : [];
  const todayIso = iso(new Date());

  // Window bounds — from the caller's 90-day span, else derived from the items.
  const starts = list.map((t) => t.item?.start_date).filter(Boolean).map((s) => String(s).slice(0, 10)).sort();
  const startIso = (start && iso(start)) || starts[0];
  if (!startIso) return <p className="text-[11px] text-[var(--text-muted)]">No weekly targets yet.</p>;
  const endIso = (end && iso(end)) || addIsoDays(startIso, 89);

  const startDate = new Date(`${startIso}T00:00:00`);
  const endDate = new Date(`${endIso}T00:00:00`);

  // Months the window covers, in calendar order.
  const monthRows = (() => {
    const first = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const last = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
    const rows = [];
    for (let m = new Date(first); m <= last; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
      const y = m.getFullYear();
      const mo = m.getMonth();
      // Week bands for this month = each Monday in the month whose week has
      // more than half its days inside the month. That drops a trailing stub
      // week that mostly belongs to the next month (e.g. Nov 30–Dec 6), so a
      // month shows at most four weeks.
      const weeks = [];
      const dim = new Date(y, mo + 1, 0).getDate();
      for (let day = 1; day <= dim; day++) {
        const d = new Date(y, mo, day);
        if (d.getDay() !== 1) continue;
        const wStart = iso(d);
        const wEnd = addIsoDays(wStart, 6);
        let inMonth = 0;
        for (let c = wStart; c <= wEnd; c = addIsoDays(c, 1)) {
          if (new Date(`${c}T00:00:00`).getMonth() === mo) inMonth++;
        }
        if (inMonth >= 4) weeks.push({ iso: wStart, start: wStart, end: wEnd });
      }
      rows.push({
        month: mo,
        year: y,
        label: new Date(y, mo, 1).toLocaleDateString(undefined, { month: "long" }),
        weeks,
        cells: new Map(),
      });
    }
    return rows;
  })();

  // Bucket each target by its own month row and the week whose Monday is on/before
  // its start date (the month's own week band), by real date.
  for (const t of list) {
    const s = t.item?.start_date ? String(t.item.start_date).slice(0, 10) : "";
    if (!s) continue;
    const sDate = new Date(`${s}T00:00:00`);
    if (isNaN(sDate.getTime())) continue;
    const row = monthRows.find((r) => r.month === sDate.getMonth() && r.year === sDate.getFullYear());
    if (!row) continue;
    const wk = row.weeks.find((w) => s >= w.start && s <= w.end) || row.weeks[0];
    if (!wk) continue;
    const arr = row.cells.get(wk.iso) || [];
    arr.push(t);
    row.cells.set(wk.iso, arr);
  }

  // Widest month row decides the column count.
  const maxWeeks = Math.max(1, ...monthRows.map((r) => r.weeks.length));

  return (
    <div data-testid="week-grid" className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div
          className="grid gap-px rounded-lg border border-[var(--border)] bg-[var(--border)] overflow-hidden"
          style={{ gridTemplateColumns: `120px repeat(${maxWeeks}, minmax(0, 1fr))` }}
        >
          {/* Header row — Week 1 … N, restarting per month. */}
          <div className="bg-[var(--bg-primary)] p-2" />
          {Array.from({ length: maxWeeks }, (_, i) => (
            <div key={i} className="bg-[var(--bg-primary)] p-2 text-center text-[11px] font-semibold text-[var(--text-secondary)]">
              Week {i + 1}
            </div>
          ))}

          {/* One row per month; its own Week 1 … N start at column one. */}
          {monthRows.map((row) => (
            <Fragment key={`${row.year}-${row.month}`}>
              <div className="bg-[var(--bg-primary)] p-2 text-[12px] font-semibold text-[var(--text-primary)] flex items-start">
                {row.label}
              </div>
              {Array.from({ length: maxWeeks }, (_, i) => {
                const wk = row.weeks[i];
                if (!wk) {
                  // Slot past this month's week count — visually empty so the
                  // trailing columns don't read as a shaded region.
                  return <div key={i} className="min-h-[96px] bg-[var(--bg-primary)]" aria-hidden="true" />;
                }
                const cells = row.cells.get(wk.iso) || [];
                const isNow = todayIso >= wk.start && todayIso <= wk.end;
                return (
                  <div
                    key={i}
                    className={`min-h-[96px] p-1.5 space-y-1 ${
                      isNow
                        ? "bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg-primary))] ring-1 ring-inset ring-[var(--accent)]"
                        : "bg-[var(--bg-primary)]"
                    }`}
                  >
                    <div className="mb-0.5">
                      <span
                        className={`text-[9px] tabular-nums ${
                          isNow
                            ? "inline-block rounded-md bg-[var(--accent)] px-1.5 py-[1px] font-semibold text-[var(--bg-primary)]"
                            : "text-[var(--text-muted)]"
                        }`}
                      >
                        {monthDay(new Date(`${wk.start}T00:00:00`))}–{monthDay(new Date(`${wk.end}T00:00:00`))}
                      </span>
                    </div>
                    {cells.map((t) => {
                      const label = t.title.replace(/^Week\s+\d+\s*[—-]\s*/i, "");
                      return (
                        <TargetCard key={t.id} target={{ ...t, title: label }} onClick={() => onSelectItem?.(t.item)} />
                      );
                    })}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
function addIsoDays(isoStr, n) {
  const d = new Date(`${isoStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
}
function monthDay(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function MonthGrid({ year, cards, onSelectItem }) {
  const byMonth = new Map();
  (cards || []).forEach((c) => {
    if (!c.date) return;
    const d = new Date(c.date);
    // Bucket by the month of the *visible* year only — previously the year
    // was ignored, so every year showed the same items (2027 repeated 2026).
    if (isNaN(d.getTime()) || d.getFullYear() !== Number(year)) return;
    const m = d.getMonth();
    const a = byMonth.get(m) || [];
    a.push(c);
    byMonth.set(m, a);
  });
  const now = new Date();
  return (
    <div data-testid="month-grid" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 12 }, (_, m) => m).map((m) => {
        const list = byMonth.get(m) || [];
        const isNow = now.getFullYear() === year && now.getMonth() === m;
        return (
          <div
            key={m}
            className={`min-h-[88px] rounded-lg border p-2 ${isNow ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,var(--bg-primary))]" : "border-[var(--border)] bg-[var(--bg-primary)]"}`}
          >
            <div className="mb-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
              <span aria-hidden="true" className="text-[var(--warning)]">◆ </span>
              <span
                className={
                  isNow
                    ? "rounded-md bg-[var(--accent)] px-1.5 py-[1px] text-[var(--bg-primary)]"
                    : ""
                }
              >
                {new Date(year, m, 1).toLocaleDateString(undefined, { month: "long" })}
              </span>
            </div>
            <div className="space-y-1">
              {list.length === 0 ? (
                <div className="text-[10px] text-[var(--text-muted)]">—</div>
              ) : (
                list.map((c) => (
                  <TargetCard key={c.id} target={c} onClick={() => onSelectItem?.(c.item)} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { WEEKDAYS };
