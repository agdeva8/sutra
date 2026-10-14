import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, RefreshCw, X } from "lucide-react";
import { localDateKey } from "../lib/utils";

/**
 * One dismissible, once-per-day toast when the state contains a time-sensitive
 * re-plan signal (drift, an infeasible date/hour edit, or a blocker/timetable collision).
 * Capacity-freed suggestions stay inline: goal-drop already offers one inside
 * its confirmation flow, and the all-surface banner covers pause/drop.
 *
 * The toast never runs the planner by itself. Its action only opens the
 * existing `review_progress` chat; proposals still require confirmation.
 */
const PRIORITY = [
  "drift",
  "infeasible_edit",
  "timetable_collision",
  "blocker_collision",
];
const ICONS = {
  drift: AlertTriangle,
  infeasible_edit: AlertTriangle,
  blocker_collision: CalendarClock,
  timetable_collision: CalendarClock,
};

/**
 * Fire the "re-plan may be needed" nudge directly. Shared by the once-per-day
 * state-driven toast below and explicit callers (e.g. removing a blocker frees
 * time, so we offer to re-plan right away instead of waiting for a suggestion).
 */
export function showReplanNudge({ message, onReplan, icon: Icon = RefreshCw }) {
  toast(
    (t) => (
      <div
        data-testid="replan-toast"
        className="flex items-start gap-3 pr-1"
        role="status"
      >
        <Icon
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--text-primary)]">
            Re-plan may be needed
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">
            {message}
          </p>
          <button
            type="button"
            data-testid="replan-toast-action"
            onClick={() => {
              toast.dismiss(t);
              onReplan?.();
            }}
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-xs font-semibold text-[var(--bg-primary)] hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Review plan
          </button>
        </div>
        <button
          type="button"
          aria-label="Dismiss re-plan reminder"
          onClick={() => toast.dismiss(t)}
          className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    ),
    { id: "gc-replan-nudge", duration: 12000, closeButton: false },
  );
}

export default function ReplanToast({ suggestions = [], onReplan }) {
  const firedForDate = useRef(null);

  useEffect(() => {
    if (!suggestions.length) return;
    const today = localDateKey();
    if (firedForDate.current === today) return;

    try {
      if (localStorage.getItem("gc_replan_toast_date") === today) {
        firedForDate.current = today;
        return;
      }
    } catch {
      // Continue if localStorage is unavailable; the ref still prevents
      // duplicate toasts during this mount.
    }

    const suggestion =
      PRIORITY.map((trigger) =>
        suggestions.find((s) => s.trigger === trigger),
      ).find(Boolean) || null;
    if (!suggestion) return;

    firedForDate.current = today;
    try {
      localStorage.setItem("gc_replan_toast_date", today);
    } catch {
      // The ref is sufficient for this mounted session.
    }

    showReplanNudge({
      message: suggestion.message,
      icon: ICONS[suggestion.trigger] || RefreshCw,
      onReplan: () => onReplan?.(suggestion),
    });
  }, [suggestions, onReplan]);

  return null;
}
