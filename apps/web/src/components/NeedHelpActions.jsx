import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  MessageSquarePlus,
  MessageSquareWarning,
} from "lucide-react";

/**
 * NeedHelpActions — the per-task "I can't do this" / "Break it down with the
 * coach" pair.
 *
 * Extracted from TodayTimetable (Iteration 7) so the Today tab and the Plan
 * tree's task rows offer the SAME affordance from ONE implementation. Both
 * callbacks open a scoped chat; neither edits anything itself.
 *
 * Chrome: on phones the two buttons collapse behind a single "Need help with
 * this?" trigger (the row is already dense); from `sm` up they sit inline.
 * Each instance owns its own open state, so expanding one row never expands
 * its siblings. Click-outside and Esc close it.
 *
 * `item` needs only `{ id }`; `_kind` is used when present to distinguish
 * blockers from tasks in the scoped chat. `prefix` namespaces the test ids so
 * the Today tab (`timetable-…`) and the Plan tree (`plan-…`) stay addressable
 * independently.
 */
export default function NeedHelpActions({
  item,
  onCant,
  onAddToPlan,
  prefix = "timetable",
  label = "Need help with this?",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const kind = item?._kind === "blocker" ? "blocker" : "plan";
  const panelId = `${prefix}-need-help-${kind}-${item?.id}`;

  return (
    <div ref={ref} className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid={`${prefix}-need-help-${item?.id}`}
        className="sm:hidden h-11 self-start inline-flex items-center gap-1.5 px-3 border border-[var(--border)] text-[var(--text-secondary)] text-xs transition-colors rounded hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        {open ? (
          <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
        )}
        {label}
      </button>
      <div
        id={panelId}
        className={`${open ? "flex" : "hidden"} sm:flex flex-col sm:flex-row gap-2`}
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onCant?.(item);
          }}
          data-testid={`${prefix}-cant-${item?.id}`}
          className="h-11 inline-flex items-center gap-1.5 px-3 border border-[var(--border)] hover:border-[var(--danger)] hover:text-[var(--danger)] text-[var(--text-secondary)] text-xs transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <MessageSquareWarning className="w-3.5 h-3.5" aria-hidden="true" />
          I can&apos;t do this
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onAddToPlan?.(item);
          }}
          data-testid={`${prefix}-plan-${item?.id}`}
          className="h-11 inline-flex items-center gap-1.5 px-3 border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] text-[var(--text-secondary)] text-xs transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <MessageSquarePlus className="w-3.5 h-3.5" aria-hidden="true" />
          Break it down with the coach
        </button>
      </div>
    </div>
  );
}
