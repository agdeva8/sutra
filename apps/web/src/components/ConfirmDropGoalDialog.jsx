import { useEffect, useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import CenteredDialog from "./CenteredDialog";
import { api } from "../lib/api";

/** The dialog's testId — also the screen-reader label prefix CenteredDialog derives from it. */
const TEST_ID = "confirm-drop-goal-dialog";

/**
 * ConfirmDropGoalDialog — the drop flow's whole conversation, in one dialog.
 *
 * Dropping used to take three steps: an action prompt asking *why*, then a focused
 * chat, then a proposal the user confirmed. The server never needed any of that —
 * `DELETE /goals/{id}` already runs the full cascade — so the reason was collected
 * and then discarded. This asks the only question that has a consequence: *what*
 * is about to go.
 *
 * The numbers come from `GET /goals/{id}/drop-impact`, which reads the same
 * `compute_goal_drop_impact` the cascade uses, so the preview and the result
 * cannot drift apart. The sentence is the cascade's own `drop_impact_sentence` —
 * ported verbatim from v1 and shown to the user — and is deliberately not
 * re-composed here; "You can't undo this." is the one line the server's sentence
 * does not carry.
 *
 * Props:
 *   open        — controlled visibility
 *   onClose     — close handler
 *   goal        — { id, title } the drop targets; null while closed
 *   onDropped   — called with the goal after the cascade succeeds
 */
export default function ConfirmDropGoalDialog({ open, onClose, goal, onDropped }) {
  const goalId = goal?.id || "";
  const [impact, setImpact] = useState(null);
  const [sentence, setSentence] = useState("");
  const [error, setError] = useState("");
  const [dropping, setDropping] = useState(false);

  // Price the drop when the dialog opens. Read-only on the server, so a user who
  // closes and reopens gets a live number rather than a cached one from a board
  // that has since moved.
  useEffect(() => {
    if (!open || !goalId) return undefined;
    let cancelled = false;
    setImpact(null);
    setSentence("");
    setError("");
    api
      .goalDropImpact(goalId)
      .then((res) => {
        if (cancelled) return;
        setImpact(res?.impact || null);
        setSentence(res?.sentence || "");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          typeof e?.message === "string" && e.message
            ? e.message
            : "Couldn't work out what this drop would remove.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, goalId]);

  if (!open) return null;

  const confirm = async () => {
    if (dropping || !goalId) return;
    setDropping(true);
    setError("");
    try {
      await api.dropGoal(goalId);
      onDropped?.(goal);
      onClose?.();
    } catch (e) {
      setError(
        typeof e?.message === "string" && e.message
          ? e.message
          : "Couldn't drop that goal. Nothing was changed — try again.",
      );
    } finally {
      setDropping(false);
    }
  };

  // The server caps both lists (`MAX_LIST`); anything past the cap is summarised
  // by the counts rather than listed, so a 40-milestone goal still reads as one line.
  const milestones = impact?.milestones || [];
  const blocks = impact?.timetable_blocks || [];
  const hiddenMilestones = Math.max(0, (impact?.counts?.milestones || 0) - milestones.length);
  const hiddenBlocks = Math.max(0, (impact?.counts?.timetable_blocks || 0) - blocks.length);

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={AlertTriangle}
      title={`Drop "${goal?.title || "this goal"}"?`}
      maxWidth="max-w-lg"
      testId={TEST_ID}
      footer={
        <>
          <button
            onClick={onClose}
            data-testid="confirm-drop-cancel"
            disabled={dropping}
            className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border)] rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            data-testid="confirm-drop-confirm"
            disabled={dropping || !impact}
            className="min-h-11 flex items-center gap-1.5 text-xs px-3 py-3 rounded bg-[var(--danger)] text-[var(--bg-primary)] font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Trash2 className="w-3 h-3" />
            {dropping ? "Dropping…" : "Drop goal"}
          </button>
        </>
      }
    >
      {error && (
        <p data-testid="confirm-drop-error" role="alert" className="text-xs text-[var(--danger)] leading-relaxed">
          {error}
        </p>
      )}

      {!impact && !error && (
        <p data-testid="confirm-drop-loading" aria-busy="true" className="text-xs text-[var(--text-secondary)]">
          Working out what this removes…
        </p>
      )}

      {impact && (
        <div className="space-y-3">
          <p data-testid="confirm-drop-sentence" className="text-sm text-[var(--text-secondary)] leading-relaxed">
            {sentence}
          </p>

          {(milestones.length > 0 || blocks.length > 0) && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-3 space-y-2">
              {milestones.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    Milestones
                  </div>
                  <ul data-testid="confirm-drop-milestones" className="mt-1 space-y-0.5">
                    {milestones.map((m) => (
                      <li key={m.id} className="text-xs text-[var(--text-secondary)] truncate">
                        {m.title}
                        {m.target_date ? ` · ${m.target_date}` : ""}
                      </li>
                    ))}
                    {hiddenMilestones > 0 && (
                      <li className="text-xs text-[var(--text-muted)]">and {hiddenMilestones} more</li>
                    )}
                  </ul>
                </div>
              )}
              {blocks.length > 0 && (
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    Planned sessions
                  </div>
                  <ul data-testid="confirm-drop-blocks" className="mt-1 space-y-0.5">
                    {blocks.map((b) => (
                      <li key={b.id} className="text-xs text-[var(--text-secondary)] truncate">
                        {b.label}
                        {b.block_date ? ` · ${b.block_date} ${b.start_time}–${b.end_time}` : ""}
                      </li>
                    ))}
                    {hiddenBlocks > 0 && (
                      <li className="text-xs text-[var(--text-muted)]">and {hiddenBlocks} more</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p data-testid="confirm-drop-irreversible" className="text-xs text-[var(--danger)]">
            You can't undo this.
          </p>
        </div>
      )}
    </CenteredDialog>
  );
}
