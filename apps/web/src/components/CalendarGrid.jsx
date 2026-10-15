import React, { useMemo, useState } from "react";
import { CalendarCard } from "./CalendarCards";
import useMediaQuery from "../hooks/useMediaQuery";

/**
 * CalendarGrid — the one grid every calendar span draws with, as a plain m × n matrix.
 *
 * Day, Week, Month, 3 Months and Year used to be four different pictures, so moving between spans
 * felt like changing product. They are all the same thing: a grid of cells, where a cell is a slice
 * of time. The caller says how many columns and rows, and what range each cell covers — nothing else.
 *
 *   cellRange(row, col) -> [start, end)   the slice of time that cell is
 *   cellLabel(row, col) -> string         what to print in it (an hour, a date, a week, a month)
 *
 * Then **one rule places every item**: an item occupies every cell its own [start, end) overlaps. One
 * cell becomes a card; several become a bar across them. That is the whole placement algorithm, and it
 * covers a timed session exactly as well as a month-long goal — a 10:30–12:30 block overlaps the 10,
 * 11 and 12 rows and draws one bar down them, which is what a calendar event is.
 *
 * No mode, no special case for hours: the hour axis is just rows whose range happens to be an hour.
 *
 * The spans, and what a cell is in each:
 *
 *   Day        1 × 24   an hour          "10 AM"
 *   Week       7 × 24   day × hour       day header, hour gutter
 *   Month      7 × 5-6  a day            "15"
 *  3 Months    4 × 4    a week           "12 Oct"
 *   Year       3 × 4    a month          "October"
 */

//: A cell narrower than a readable card draws its items as dots (a goal-coloured dot each, "+n" past
//: `COMPACT_MAX_DOTS`), and a tap opens the day. Applies when many columns share a phone-width screen.
const COMPACT_QUERY = "(max-width: 640px)";
const COMPACT_MIN_COLUMNS = 6;
const COMPACT_MAX_DOTS = 3;

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? new Date(v) : new Date(`${String(v).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : startOfDay(d);
};

/** The range an item covers: `item.start`/`item.end` when it spans, else its own `date`. */
function rangeOf(card) {
  const s = asDate(card?.item?.start || card?.date);
  if (!s) return null;
  const e = asDate(card?.item?.end || card?.date) || s;
  // An item with a clock time runs to the end of its slot, not to midnight of the same day.
  const startAt = card?.item?.startAt instanceof Date ? card.item.startAt : s;
  const endAt = card?.item?.endAt instanceof Date ? card.item.endAt : new Date(e.getTime() + 86400000);
  return { start: startAt, end: endAt };
}

export default function CalendarGrid({
  columns = 7,
  rows = 1,
  cellRange,
  cellLabel,
  columnHeader, // (col) => node, rendered above the grid
  rowLabel, // (row) => node, rendered in the left gutter
  cards = [],
  today = new Date(),
  onSelectItem,
  onSelectDay,
  onSelectSlot,
  //: `(card, targetStart) => void`. Supplying it makes bars draggable; the caller decides whether the
  //: move is allowed (it owns the other blocks, so it is the one that can see a conflict).
  onBlockDrop = null,
  testId = "calendar-grid",
  rowPx = null,
  minCellPx = 120,
  //: True only for grids whose row 0 is an all-day row (Day, Week). There an item with no clock time sits
  //: in row 0 of its day's column. Everywhere else (Month, 3 Months, Year) row 0 is just the first week
  //: or the first months, so an untimed item must go to whichever cells its own dates overlap.
  allDayRow = false,
}) {
  const narrow = useMediaQuery(COMPACT_QUERY);
  const compact = narrow && columns >= COMPACT_MIN_COLUMNS && !allDayRow;
  const todayTime = startOfDay(today).getTime();
  //: The bar being dragged. Kept in state so the cells can offer themselves as drop targets only
  //: while a drag is actually happening.
  const [dragging, setDragging] = useState(null);

  // Every cell's range, computed once. This is the only place the shape of the span is encoded.
  const cellRanges = useMemo(() => {
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < columns; c++) {
        const [s, e] = cellRange(r, c);
        row.push({ start: s, end: e });
      }
      out.push(row);
    }
    return out;
  }, [rows, columns, cellRange]);

  // One rule for every item: the cells its own range overlaps. A single cell draws a card, several
  // draw one bar across them — no branch on whether the item is "timed".
  const { singles, bars } = useMemo(() => {
    const singles = cellRanges.map((row) => row.map(() => []));
    const bars = [];
    (cards || []).forEach((card) => {
      // An item with no clock time has no hour to sit in, so it belongs in the all-day row (row 0) of
      // the column its date falls in. That is the one rule the overlap test cannot express — a task
      // "on the 15th" covers the whole day, so by pure overlap it would smear down all 24 rows.
      if (allDayRow && !(card?.item?.startAt instanceof Date)) {
        const day = asDate(card?.date || card?.item?.start || card?.item?.date);
        if (!day) return;
        for (let ci = 0; ci < columns; ci++) {
          const cell = cellRanges[0][ci];
          if (day >= cell.start && day < cell.end) {
            singles[0][ci].push(card);
            return;
          }
        }
        return;
      }
      const r = rangeOf(card);
      if (!r) return;
      let r0 = Infinity;
      let r1 = -Infinity;
      let c0 = Infinity;
      let c1 = -Infinity;
      for (let ri = 0; ri < rows; ri++) {
        // Row 0 of a Day/Week grid is the all-day row, whose range is the whole day: a timed item overlaps it
        // by definition, and counting it would stretch every session up through the all-day row.
        if (allDayRow && ri === 0) continue;
        for (let ci = 0; ci < columns; ci++) {
          const cell = cellRanges[ri][ci];
          if (r.end <= cell.start || r.start >= cell.end) continue;
          r0 = Math.min(r0, ri);
          r1 = Math.max(r1, ri);
          c0 = Math.min(c0, ci);
          c1 = Math.max(c1, ci);
        }
      }
      if (r0 === Infinity) return; // outside the visible window
      if (r0 === r1 && c0 === c1) singles[r0][c0].push(card);
      else bars.push({ card, r0, r1, c0, c1 });
    });
    return { singles, bars };
  }, [cards, cellRanges, rows, columns, allDayRow]);

  const gutter = rowLabel ? 1 : 0;
  const headerRow = columnHeader ? 1 : 0;
  const gridColumn = (c) => `${c + 1 + gutter} / ${c + 2 + gutter}`;
  const gridRow = (r) => `${r + 1 + headerRow} / ${r + 2 + headerRow}`;

  return (
    <div
      data-testid={testId}
      className="max-h-[76vh] overflow-auto rounded-lg border border-[var(--border-accent)] bg-[var(--bg-primary)]"
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: `${gutter ? "56px " : ""}repeat(${columns}, minmax(0, 1fr))`,
          // The all-day row (Day/Week) grows with what is in it: two items on one day both show, instead of the
          // second being clipped and appearing only on hover. The hour rows stay a fixed height.
          gridTemplateRows: allDayRow && rowPx
            ? `${headerRow ? "32px " : ""}minmax(${rowPx}px, auto) repeat(${rows - 1}, ${rowPx}px)`
            : `${headerRow ? "32px " : ""}repeat(${rows}, ${rowPx ? `${rowPx}px` : `minmax(${minCellPx}px, auto)`})`,
        }}
      >
        {columnHeader && (
          <>
            {gutter ? <div className="sticky top-0 z-10 border-b border-r border-[var(--border)] bg-[var(--bg-primary)]" /> : null}
            {Array.from({ length: columns }, (_, c) => (
              <div
                key={`h-${c}`}
                className="sticky top-0 z-10 flex items-center justify-center border-b border-l border-[var(--border)] bg-[var(--bg-primary)] px-2 text-[11px] font-medium text-[var(--text-primary)]"
              >
                {columnHeader(c)}
              </div>
            ))}
          </>
        )}

        {Array.from({ length: rows }, (_, r) =>
          Array.from({ length: columns }, (_, c) => {
            const cell = cellRanges[r][c];
            const isToday = todayTime >= cell.start.getTime() && todayTime < cell.end.getTime();
            return (
              <React.Fragment key={`${r}-${c}`}>
                {c === 0 && rowLabel ? (
                  <div className="border-b border-r border-[var(--border)] pr-1 text-right text-[9px] text-[var(--text-muted)]">
                    {rowLabel(r)}
                  </div>
                ) : null}
                <div
                  role={onSelectDay || onSelectSlot ? "button" : undefined}
                  tabIndex={onSelectDay || onSelectSlot ? 0 : undefined}
                  onClick={onSelectSlot ? () => onSelectSlot(cell.start, r) : onSelectDay ? () => onSelectDay(cell.start) : undefined}
                  onKeyDown={
                    onSelectDay || onSelectSlot
                      ? (e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          if (onSelectSlot) onSelectSlot(cell.start, r);
                          else onSelectDay(cell.start);
                        }
                      : undefined
                  }
                  // A cell takes a dropped bar and hands the caller the slot it landed on. It does not
                  // decide whether the move is legal — the caller owns the other blocks and is the only
                  // one that can see a conflict.
                  onDragOver={
                    dragging && onBlockDrop
                      ? (e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      : undefined
                  }
                  onDrop={
                    dragging && onBlockDrop
                      ? (e) => {
                          e.preventDefault();
                          const card = dragging;
                          setDragging(null);
                          onBlockDrop(card, cell.start);
                        }
                      : undefined
                  }
                  style={{ gridColumn: gridColumn(c), gridRow: gridRow(r) }}
                  className={[
                    "relative border-b border-l border-[var(--border)] px-1 pt-0.5 pb-1",
                    dragging ? "ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent)_30%,transparent)]" : "",
                    isToday ? "bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-primary))]" : "bg-[var(--bg-primary)]",
                    onSelectDay || onSelectSlot
                      ? "cursor-pointer hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
                      : "",
                  ].join(" ")}
                >
                  {cellLabel && (
                    <div className="mb-0.5 flex justify-end">
                      <span
                        className={[
                          "inline-flex max-w-full items-center rounded-full px-1.5 text-[10px] tabular-nums",
                          isToday ? "bg-[var(--accent)] font-semibold text-[var(--bg-primary)]" : "text-[var(--text-secondary)]",
                        ].join(" ")}
                      >
                        <span className="truncate">{cellLabel(r, c)}</span>
                      </span>
                    </div>
                  )}
                  {compact && singles[r][c].length > 0 && (
                    <div className="flex flex-wrap items-center gap-0.5 px-0.5" data-testid="cal-dots" aria-label={`${singles[r][c].length} planned`}>
                      {singles[r][c].slice(0, COMPACT_MAX_DOTS).map((card) => (
                        <span key={card.id} className="h-2 w-2 rounded-full" style={{ background: card.color }} aria-hidden="true" />
                      ))}
                      {singles[r][c].length > COMPACT_MAX_DOTS && (
                        <span className="text-[9px] leading-none text-[var(--text-muted)]">+{singles[r][c].length - COMPACT_MAX_DOTS}</span>
                      )}
                    </div>
                  )}
                  {!compact && singles[r][c].length > 0 && (
                    <div className="space-y-1">
                      {singles[r][c].map((card) => (
                        <CalendarCard key={card.id} card={card} onClick={() => onSelectItem?.(card.item)} />
                      ))}
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          }),
        )}

        {/* Bars last, so they paint over the cell borders they cross. */}
        {bars.map((b) => (
          <button
            key={`bar-${b.card.id}`}
            type="button"
            data-testid={`cal-bar-${b.card.id}`}
            // Draggable only where the caller can accept a move. Dropping *onto* another bar is how a
            // clash is expressed, so a bar accepts drops too — the caller then refuses or swaps.
            draggable={Boolean(onBlockDrop)}
            onDragStart={
              onBlockDrop
                ? (e) => {
                    setDragging(b.card);
                    e.dataTransfer.effectAllowed = "move";
                  }
                : undefined
            }
            onDragEnd={() => setDragging(null)}
            onDragOver={
              dragging && onBlockDrop && dragging.id !== b.card.id
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }
                : undefined
            }
            onDrop={
              dragging && onBlockDrop && dragging.id !== b.card.id
                ? (e) => {
                    e.preventDefault();
                    const card = dragging;
                    setDragging(null);
                    onBlockDrop(card, b.card.item.startAt);
                  }
                : undefined
            }
            onClick={(e) => {
              e.stopPropagation();
              onSelectItem?.(b.card.item);
            }}
            aria-label={`${b.card.title}${b.card.goalTitle ? `, ${b.card.goalTitle}` : ""}`}
            style={{
              gridColumn: `${b.c0 + 1 + gutter} / ${b.c1 + 2 + gutter}`,
              gridRow: `${b.r0 + 1 + headerRow} / ${b.r1 + 2 + headerRow}`,
              margin: "2px 3px",
              background:
                b.card.look === "stripes"
                  ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${b.card.color} 24%, var(--bg-primary)) 0 6px, color-mix(in srgb, ${b.card.color} 10%, var(--bg-primary)) 6px 12px)`
                  : `color-mix(in srgb, ${b.card.color} 16%, var(--bg-primary))`,
              boxShadow: `inset 3px 0 0 0 ${b.card.color}`,
            }}
            className="z-10 flex items-center gap-1.5 overflow-hidden rounded-[3px] px-1.5 text-left text-[11px] font-medium text-[var(--text-primary)] transition-[filter] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
          >
            <span aria-hidden="true" className="shrink-0">
              {b.card.glyph || ""}
            </span>
            <span className="truncate">{b.card.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
