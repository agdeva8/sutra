import React from "react";

/**
 * Calendar card grid — Option C presentation.
 *
 * Each item is a 3-line breadcrumb card:
 *   line 1  the task / commitment / milestone (○ / ⚑ / ◆)
 *   line 2  the commitment the task advances
 *   line 3  "<goal> › fulfils <milestone> · <hours>"
 * A left stripe carries the goal colour.
 *
 * `cards` are pre-enriched by the caller (goal title/colour, commitment,
 * fulfils, hours) so this stays presentational.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function CalendarCard({ card, onClick }) {
  return (
    <button
      type="button"
      data-testid={`cal-card-${card.id}`}
      onClick={onClick}
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
      {card.commitment && (
        <div className="truncate text-[9px] leading-tight text-[var(--text-secondary)]">
          <span aria-hidden="true">⚑ </span>
          {card.commitment}
        </div>
      )}
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
        <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
          <span aria-hidden="true">{target.glyph} </span>
          {target.title}
        </span>
        {target.hours ? (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{target.hours}</span>
        ) : null}
      </div>
      <div className="truncate text-[10px] leading-tight text-[var(--text-muted)]">
        {target.goalTitle}
        {target.phase ? ` · ${target.phase}` : ""}
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

/** 3-month view — a proper grid of week cells (Week 1 … N), each with its target. */
export function WeekGrid({ items, onSelectItem }) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return <p className="text-[11px] text-[var(--text-muted)]">No weekly targets yet.</p>;
  }
  const todayIso = iso(new Date());
  return (
    <div data-testid="week-grid" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {list.map((t) => {
        // "current" = the first week whose range has not yet passed: today is
        // inside the week, OR today is before it and no earlier week is later.
        const startIso = t.item?.start_date ? String(t.item.start_date).slice(0, 10) : "";
        const endIso = t.item?.end_date ? String(t.item.end_date).slice(0, 10) : "";
        const isNow = startIso && endIso ? todayIso >= startIso && todayIso <= endIso : false;
        const num = (t.title.match(/Week\s+(\d+)/i) || [])[1] || "";
        const label = t.title.replace(/^Week\s+\d+\s*[—-]\s*/i, "");
        // Fallback: if today is before this plan's first week (e.g. the plan
        // starts tomorrow), mark the earliest week as the current one.
        const isCurrent = isNow || (startIso && todayIso < startIso && num === "1");
        return (
          <div
            key={t.id}
            className={`min-h-[92px] rounded-lg border p-2 ${isCurrent ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]" : "border-[var(--border)]"}`}
          >
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                <span aria-hidden="true" className={isCurrent ? "text-[var(--accent)]" : "text-[var(--accent)]"}>▤ </span>
                <span
                  className={
                    isCurrent
                      ? "rounded-md bg-[var(--accent)] px-1.5 py-[1px] text-[var(--bg-primary)]"
                      : ""
                  }
                >
                  Week {num}
                </span>
              </span>
              {t.hours ? <span className="text-[10px] tabular-nums text-[var(--text-muted)]">{t.hours}</span> : null}
            </div>
            {t.when && <div className="mb-1 text-[10px] tabular-nums text-[var(--text-muted)]">{t.when}</div>}
            <TargetCard target={{ ...t, title: label }} onClick={() => onSelectItem?.(t.item)} />
          </div>
        );
      })}
    </div>
  );
}
export function MonthGrid({ year, cards, onSelectItem }) {
  const byMonth = new Map();
  (cards || []).forEach((c) => {
    if (!c.date) return;
    const m = new Date(c.date).getMonth();
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
            className={`min-h-[88px] rounded-lg border p-2 ${isNow ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,transparent)]" : "border-[var(--border)]"}`}
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
