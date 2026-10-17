import React from "react";
import {
  ALERT_GLYPH,
  KIND_META,
  REPEAT_GLYPH,
  blockSurface,
  milestoneOverdue,
  taskState,
  whenLabel,
} from "../constants/blockKinds";

/**
 * A block of the four-kind model (Event / Task / Away / Milestone) on the calendar.
 *
 * Presentational: the caller enriches it (goal title) and owns the callbacks. The Task checkbox is
 * the one quick action on the card itself — everything else opens the detail sheet, so the card
 * stays a target you can aim at with a thumb. Colour says who it belongs to, the glyph and the
 * texture say what it is (see constants/blockKinds.js).
 *
 * Props:
 *   block       — one of contracts/blocks.py: EventBlock | TaskBlock | AwayBlock | MilestoneBlock
 *   goalTitle   — the attached goal's title, for the sub-line
 *   density     — "grid" (default: compact card on the hour grid / month cell) or
 *                 "row" (a ≥44px day-list row, comfortable to tick)
 *   onClick     — tap anywhere but the checkbox: open the detail sheet
 *   onToggleDone — tap the checkbox: quick-tick a task (done ↔ open)
 *   today       — Date used to compute milestone overdue (defaults to now)
 */
export default function BlockCard({ block, goalTitle, density = "grid", onClick, onToggleDone, today }) {
  if (!block) return null;
  const kind = block.block_kind;
  const meta = KIND_META[kind];
  const state = taskState(block);
  const done = state === "done";
  const overdue = milestoneOverdue(block, today);
  const when = whenLabel(block);
  const titleCls = done
    ? "line-through text-[var(--text-muted)]"
    : overdue
    ? "text-[var(--danger)]"
    : "text-[var(--text-primary)]";
  const isRow = density === "row";

  return (
    <div
      data-testid={`block-card-${block.id}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={`w-full text-left rounded transition-[filter] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] ${
        isRow ? "flex min-h-11 items-center gap-2 px-2 py-1.5" : "px-1.5 py-1"
      } ${state === "skip" ? "opacity-50" : ""}`}
      style={blockSurface(block)}
    >
      {kind === "task" && (
        <TaskCheckbox state={state} onClick={(e) => { e.stopPropagation(); onToggleDone?.(block); }} />
      )}
      <div className="min-w-0 flex-1">
        <div className={`flex items-center gap-1 ${isRow ? "text-[13px]" : "text-[11px]"} leading-tight`}>
          <span aria-hidden="true" className="shrink-0">{meta.glyph}</span>
          <span className={`truncate ${titleCls}`}>{block.title}</span>
          {block.repeat && <span aria-label="Repeats" className="shrink-0 text-[var(--text-muted)]">{REPEAT_GLYPH}</span>}
          {block.alert_before != null && <span aria-label="Has an alert" className="shrink-0 text-[var(--text-muted)]">{ALERT_GLYPH}</span>}
        </div>
        {(goalTitle || when) && (
          <div className={`truncate ${isRow ? "text-[10px]" : "text-[9px]"} leading-tight text-[var(--text-muted)]`}>
            {goalTitle ? `${goalTitle}${when ? " · " : ""}` : ""}
            {when}
            {state === "partial" ? " · partly done" : ""}
            {state === "skip" ? " · skipped" : ""}
            {block.reached ? " · reached" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The tick: a tap means done (or back to open). Partly-done and skipped are chosen in the detail
 * sheet — long-press can come later as a shortcut, but the sheet is where they live so the states
 * are never hidden behind an invisible gesture.
 */
function TaskCheckbox({ state, onClick }) {
  const shape =
    state === "done"
      ? "✔"
      : state === "partial"
      ? "◐"
      : state === "skip"
      ? "–"
      : "";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "done"}
      aria-label={state === "done" ? "Mark not done" : "Mark done"}
      data-testid="block-check"
      onClick={onClick}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
        state === "done"
          ? "border-transparent bg-[var(--accent)] text-[var(--bg-primary)]"
          : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]"
      }`}
    >
      {shape}
    </button>
  );
}
