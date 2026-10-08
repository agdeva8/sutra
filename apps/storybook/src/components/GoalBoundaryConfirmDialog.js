import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Check } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

/**
 * GoalBoundaryConfirmDialog — opens whenever a source mutation crosses a
 * goal boundary (source added that fills a missing gap, source removed
 * that was the only evidence for a milestone, source reattached to a
 * different goal). The user chooses whether the coach should re-plan
 * the affected goal or leave it as-is.
 *
 * Props:
 *   open          — controlled visibility
 *   onClose       — close handler
 *   changeType    — "added" | "removed" | "reattached"
 *   sourceName    — the source's display name
 *   affectedGoals — array of { id, title, reason } describing which
 *                   goals the change touches and why
 *   onReplan      — ({goalIds}) => Promise  (default: sends a chat msg)
 *   onKeep        — () => void (default: just close)
 */
export default function GoalBoundaryConfirmDialog({
  open,
  onClose,
  changeType = "added",
  sourceName = "",
  affectedGoals = [],
  onReplan = null,
  onKeep = null,
}) {
  // Reset handled by parent (single open/close cycle). Nothing to do here.

  if (!open || affectedGoals.length === 0) return null;

  const verb =
    changeType === "removed" ? "removed" :
    changeType === "reattached" ? "reattached" :
    "added";

  const handleReplan = async () => {
    if (onReplan) {
      await onReplan({ goalIds: affectedGoals.map((g) => g.id) });
    }
    onClose?.();
  };

  const handleKeep = () => {
    if (onKeep) onKeep();
    onClose?.();
  };

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={AlertTriangle}
      title="This changed a goal's boundaries"
      subtitle={`${sourceName ? `"${sourceName}" was ${verb}` : `A source was ${verb}`}. The coach wants to know if the affected goal needs to be re-planned.`}
      maxWidth="max-w-lg"
      testId="goal-boundary-confirm-dialog"
      footer={
        <>
          <button
            onClick={handleKeep}
            data-testid="goal-boundary-keep"
            className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border)] rounded"
          >
            <Check className="w-3 h-3" /> Keep as is
          </button>
          <button
            onClick={handleReplan}
            data-testid="goal-boundary-replan"
            className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 rounded bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 transition-opacity"
          >
            <RefreshCw className="w-3 h-3" /> Re-plan affected goal{affectedGoals.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <ul data-testid="goal-boundary-list" className="space-y-2">
        {affectedGoals.map((g) => (
          <li
            key={g.id}
            data-testid={`goal-boundary-item-${g.id}`}
            className="border border-[var(--border)] bg-[var(--bg-primary)] rounded-md p-3"
          >
            <div className="text-sm font-medium text-[var(--text-primary)]">{g.title}</div>
            {g.reason && (
              <p className="mt-1 text-xs text-[var(--text-secondary)] leading-relaxed">
                {g.reason}
              </p>
            )}
          </li>
        ))}
      </ul>
    </CenteredDialog>
  );
}
