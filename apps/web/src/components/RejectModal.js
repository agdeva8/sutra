import { useEffect, useState } from "react";
import { X, Loader2, RotateCcw } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

// Per-action reject reasons (Iteration 9 — quick chips so users
// don't have to write a sentence for routine rejections).
const REJECT_CHIPS_BY_ACTION = {
  create_goal: [
    "Not a priority right now",
    "Already covered by another goal",
    "Too ambitious",
    "Wrong category",
    "Wrong timing",
  ],
  update_goal: [
    "Wrong direction",
    "Don't want this change",
    "Wrong goal",
  ],
  add_milestone: [
    "Don't need this milestone",
    "Duplicate of another",
    "Wrong date",
    "Wrong scope",
  ],
  add_blocker: [
    "Not a blocker — just busy",
    "Wrong window",
    "Wrong scope",
  ],
  drop_goal: [
    "Don't drop",
    "Wrong goal",
    "Need a different change",
  ],
  pause_goal: [
    "Don't pause",
    "Wrong window",
    "Wrong goal",
  ],
  set_goal_dates: [
    "Wrong dates",
    "Don't change the timeline",
  ],
};
const DEFAULT_REJECT_CHIPS = [
  "Wrong direction",
  "Need to think more",
  "Wrong goal",
];

/**
 * RejectModal — open from ToolConfirmationPrompt's "Reject" button.
 *
 * Founder feedback (Iteration 9): every reject captures a reason. The
 * reason is sent to `/api/tools/reject` (extended to accept an optional
 * `reason` field) and recorded in the audit log. Reasons help the
 * coach learn what's wrong with its proposals and feed the future
 * multi-agent recommendation system (Iteration 10).
 *
 * Props:
 *   open                — controlled open state
 *   onClose             — close handler
 *   proposalTitle       — the proposal's name (e.g. "Ship side-project MVP"),
 *                         used to label what the user is rejecting
 *   proposalActionKey   — the canonical action key (e.g. "create_goal")
 *                         used to pick the chip library
 *   onSubmit            — async (reason) => void; the parent calls
 *                         api.reject(messageId, proposalId, reason)
 *
 * The component is dumb — it owns only its input + busy state.
 */
export default function RejectModal({
  open,
  onClose,
  proposalTitle = "",
  proposalActionKey = "",
  initialValue = "",
  onSubmit,
  onClear,
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipReason, setSkipReason] = useState(false);

  useEffect(() => {
    if (open) {
      setReason(initialValue || "");
      setBusy(false);
      setError("");
      setSkipReason(false);
    }
  }, [open, initialValue]);

  const chips = (proposalActionKey && REJECT_CHIPS_BY_ACTION[proposalActionKey]) || DEFAULT_REJECT_CHIPS;

  const tapChip = (chip) => {
    setReason((prev) => {
      const cur = prev.trim();
      if (!cur) return chip;
      if (cur.toLowerCase().includes(chip.toLowerCase())) return cur;
      return `${cur}, ${chip}`;
    });
  };

  const submit = async () => {
    if (busy) return;
    const r = skipReason ? "" : reason.trim();
    setBusy(true);
    setError("");
    try {
      await onSubmit?.(r);
      onClose?.();
    } catch (e) {
      setError(typeof e?.message === "string" ? e.message : "Couldn't reject that. Try again.");
    } finally {
      setBusy(false);
    }
  };

  // No auto-submit on Enter — founder feedback (Iteration 9+, mid-slice):
  // free-text typing shouldn't fire the reject until the user explicitly
  // taps "Reject" below. Shift+Enter still inserts a newline; Enter is
  // reserved for the explicit button.
  const onKey = (e) => {
    if (e.key === "Enter" && e.shiftKey) {
      // Default behaviour — insert newline at caret.
      return;
    }
    // Plain Enter does NOT submit.
  };

  return (
    <CenteredDialog
      open={open}
      onClose={busy ? undefined : onClose}
      icon={X}
      title={proposalTitle ? `Reject "${proposalTitle}"` : "Reject this"}
      subtitle="Tell the coach why so future proposals get sharper. Skip if you'd rather not."
      maxWidth="max-w-xl"
      testId="reject-modal"
    >
      <div className="space-y-3">
        {chips.length > 0 && (
          <div data-testid="reject-modal-chips" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`reject-chip-${c.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                onClick={() => tapChip(c)}
                disabled={busy || skipReason}
                className="min-h-11 text-left text-xs px-2.5 py-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <label
          htmlFor="reject-modal-input"
          className="block text-xs font-medium text-[var(--text-muted)]"
        >
          Why reject?
        </label>
        <textarea
          id="reject-modal-input"
          data-testid="reject-modal-input"
          autoFocus={!skipReason && chips.length === 0}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          disabled={busy || skipReason}
          placeholder="e.g. The target date is too soon, the first step is too big, this duplicates an existing goal…"
          className="block w-full bg-[var(--bg-primary)] border border-[var(--border)] focus:border-[var(--border-accent)] rounded px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none disabled:opacity-50"
        />
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            data-testid="reject-modal-skip"
            checked={skipReason}
            onChange={(e) => setSkipReason(e.target.checked)}
            disabled={busy}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Skip the reason — just reject it
        </label>
        {error && (
          <p data-testid="reject-modal-error" role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 pt-1">
          {initialValue && (
            <button
              type="button"
              data-testid="reject-modal-clear"
              onClick={() => { onClear?.(); onClose?.(); }}
              disabled={busy}
              className="flex items-center gap-1.5 min-h-11 px-3 text-xs font-medium text-[var(--success)] hover:bg-[color-mix(in_srgb,var(--success)_10%,transparent)] rounded-xl transition-colors disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Un-reject
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              data-testid="reject-modal-cancel"
              onClick={onClose}
              disabled={busy}
              className="min-h-11 px-3 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="reject-modal-submit"
              onClick={submit}
              disabled={busy || (!skipReason && !reason.trim())}
              className="flex items-center gap-1.5 min-h-11 px-4 text-xs font-medium bg-[var(--danger)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 transition-opacity rounded-xl"
          >
            {busy ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Rejecting…
              </>
            ) : (
              <>
                <X className="w-3.5 h-3.5" aria-hidden="true" /> Reject
              </>
            )}
          </button>
          </div>
        </div>
      </div>
    </CenteredDialog>
  );
}