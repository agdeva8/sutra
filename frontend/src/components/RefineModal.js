import { useEffect, useState } from "react";
import { Pencil, Check, Loader2, RotateCcw } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

// Per-action chip library — common refine instructions so users
// don't have to write a sentence. Tapping a chip fills the textarea;
// tapping a second chip appends with a comma.
const REFINE_CHIPS_BY_ACTION = {
  create_goal: [
    "Push the target date later",
    "Pull the target date earlier",
    "Make the first step smaller",
    "Sharpen the 'why'",
    "Change the horizon (weekly/short/medium/long)",
    "Tighten the scope",
  ],
  update_goal: [
    "Rename it",
    "Push the target date later",
    "Pull the target date earlier",
    "Change the horizon",
    "Update the 'why'",
  ],
  add_milestone: [
    "Push the target date later",
    "Pull the target date earlier",
    "Make the milestone smaller",
    "Make it more measurable",
  ],
  add_blocker: ["Shorter window", "Move the window earlier", "Move the window later"],
  drop_goal: ["Don't drop — pause it instead", "Wrong goal"],
  pause_goal: ["Don't pause — drop it", "Longer pause window", "Shorter pause window"],
  set_goal_dates: ["Push the dates later", "Pull the dates earlier"],
};
const DEFAULT_REFINE_CHIPS = ["Try again from scratch", "Different framing", "Smaller scope"];

/**
 * RefineModal — records a refinement NOTE on a proposal.
 *
 * Iteration 9+ (founder feedback): clicking Refine does NOT call the LLM.
 * The note is stored on the card; clicking Refine again reopens this
 * modal pre-filled so the user can update it. All refinements are applied
 * at once from the pinned "Refine goals" button.
 *
 * Props:
 *   open, onClose, proposalTitle, proposalAction, proposalActionKey
 *   initialValue — the existing refinement (pre-fills; empty for a new one)
 *   onSubmit(thought) — stores the note on the proposal
 */
export default function RefineModal({
  open,
  onClose,
  proposalTitle = "",
  proposalAction = "change",
  proposalActionKey = "",
  initialValue = "",
  onSubmit,
  onClear,
}) {
  const [thought, setThought] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setThought(initialValue || "");
      setBusy(false);
      setError("");
    }
  }, [open, initialValue]);

  const chips = (proposalActionKey && REFINE_CHIPS_BY_ACTION[proposalActionKey]) || DEFAULT_REFINE_CHIPS;

  const tapChip = (chip) => {
    setThought((prev) => {
      const cur = prev.trim();
      if (!cur) return chip;
      if (cur.toLowerCase().includes(chip.toLowerCase())) return cur;
      return `${cur}, ${chip}`;
    });
  };

  const submit = () => {
    const t = thought.trim();
    if (!t) return;
    setBusy(true);
    try {
      onSubmit?.(t);
      onClose?.();
    } catch (e) {
      setError(typeof e?.message === "string" ? e.message : "Couldn't save that refinement.");
    } finally {
      setBusy(false);
    }
  };

  // Enter inserts a newline; the explicit button submits.
  const onKey = () => {};

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={Pencil}
      title={proposalTitle ? `Refine "${proposalTitle}"` : "Refine this"}
      subtitle={`What should change about this ${proposalAction}? It's saved on the card — apply all your refinements together with the "Refine goals" button.`}
      maxWidth="max-w-xl"
      testId="refine-modal"
    >
      <div className="space-y-3">
        {chips.length > 0 && (
          <div data-testid="refine-modal-chips" className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`refine-chip-${c.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                onClick={() => tapChip(c)}
                disabled={busy}
                className="min-h-11 text-left text-xs px-2.5 py-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <label htmlFor="refine-modal-input" className="block text-xs font-medium text-[var(--text-muted)]">
          Your note
        </label>
        <textarea
          id="refine-modal-input"
          data-testid="refine-modal-input"
          autoFocus
          value={thought}
          onChange={(e) => setThought(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          disabled={busy}
          placeholder="e.g. Push the target date a month later, make the first step smaller…"
          className="block w-full bg-[var(--bg-primary)] border border-[var(--border)] focus:border-[var(--border-accent)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none disabled:opacity-50"
        />
        {error && (
          <p data-testid="refine-modal-error" role="alert" className="text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 pt-1">
          {initialValue && (
            <button
              type="button"
              data-testid="refine-modal-clear"
              onClick={() => { onClear?.(); onClose?.(); }}
              disabled={busy}
              className="flex items-center gap-1.5 min-h-11 px-3 text-xs font-medium text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] rounded-xl transition-colors disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Revert
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              data-testid="refine-modal-cancel"
              onClick={onClose}
              disabled={busy}
              className="min-h-11 px-3 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="refine-modal-submit"
              onClick={submit}
              disabled={!thought.trim() || busy}
              className="flex items-center gap-1.5 min-h-11 px-4 text-xs font-semibold bg-[var(--accent)] text-[var(--bg-primary)] disabled:opacity-40 hover:opacity-90 transition-opacity rounded-xl"
            >
              {busy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Saving…
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  {initialValue ? "Update refinement" : "Add refinement"}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </CenteredDialog>
  );
}
