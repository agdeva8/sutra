import { useState } from "react";
import { AlertTriangle, CalendarClock, RefreshCw, Sparkles, X } from "lucide-react";

/**
 * ReplanSuggestions — the deterministic, opt-in "you should re-plan" banner.
 *
 * Fed by `state.replan_suggestions` (see api/lib/replan-suggestions.ts), which
 * fires on five signals: capacity freed, drift, blocker/goal-window overlap,
 * infeasible goal edits, or a goal-linked timetable block conflict.
 *
 * Nothing here auto-runs: each row opens the existing `review_progress` chat
 * (via `onReplan`) where the coach proposes changes the user confirms through
 * the normal proposal flow. Dismissal is per-session (not persisted) — the
 * signal itself is state-derived and will re-appear until the underlying
 * condition clears.
 */
const TRIGGER_ICON = {
  capacity_freed: Sparkles,
  drift: AlertTriangle,
  blocker_collision: CalendarClock,
  timetable_collision: CalendarClock,
  infeasible_edit: AlertTriangle,
};

export default function ReplanSuggestions({ suggestions = [], onReplan, active = true }) {
  const [dismissed, setDismissed] = useState(() => new Set());
  const visible = suggestions.filter((s) => !dismissed.has(s.id));
  if (!active || visible.length === 0) return null;

  const dismiss = (id) =>
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

  return (
    <section
      data-testid="replan-suggestions"
      aria-label="Re-plan suggestions"
      className="space-y-2"
    >
      {visible.map((s) => {
        const Icon = TRIGGER_ICON[s.trigger] || RefreshCw;
        return (
          <div
            key={s.id}
            data-testid={`replan-suggestion-${s.trigger}`}
            className="flex flex-wrap items-start gap-3 rounded-xl border border-[var(--border-accent)] bg-[var(--bg-secondary)] p-3"
          >
            <Icon
              className="w-4 h-4 mt-0.5 text-[var(--accent)] shrink-0"
              aria-hidden="true"
            />
            <p className="flex-1 min-w-[200px] text-[13px] leading-relaxed text-[var(--text-primary)]">
              {s.message}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`replan-suggestion-action-${s.trigger}`}
                onClick={() => onReplan?.(s)}
                className="min-h-9 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90 transition-opacity"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Re-plan
              </button>
              <button
                type="button"
                data-testid={`replan-suggestion-dismiss-${s.trigger}`}
                aria-label="Dismiss re-plan suggestion"
                onClick={() => dismiss(s.id)}
                className="min-h-9 w-9 inline-flex items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
