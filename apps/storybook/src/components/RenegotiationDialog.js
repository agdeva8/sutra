import { AlertTriangle, ChevronRight } from "lucide-react";
import CenteredDialog from "./CenteredDialog";

/**
 * RenegotiationDialog — Iteration 10 (Goal Planner).
 *
 * The Stage 3.5 headroom check (programmatic, no LLM) rejects a plan that
 * would over-commit the user. The server returns `status: 'renegotiate'` with
 * the numbers (`headroom`) and the four options to resolve it. This dialog is
 * the surface for that — an iOS-style grouped inset list, matching the Apple
 * theme's Settings pattern in the app.
 *
 * It is presentational only: the parent owns the server call and passes the
 * chosen option back. Four options, always in this order:
 *   shift_existing_target | drop_existing_commitment |
 *   extend_new_timeline   | reduce_new_hours
 */

const OPTION_COPY = {
  shift_existing_target: {
    title: "Shift an existing goal’s target date",
    desc: "Push another active goal later to free weekly hours for this one.",
  },
  drop_existing_commitment: {
    title: "Drop a commitment from an existing goal",
    desc: "Remove one smaller promise so this plan fits.",
  },
  extend_new_timeline: {
    title: "Extend this goal’s timeline",
    desc: "Keep the scope, spread the same work over more weeks.",
  },
  reduce_new_hours: {
    title: "Reduce this goal’s weekly hours",
    desc: "Commit to less each week and take longer to finish.",
  },
};

function fmtHours(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return Math.round(n * 10) / 10;
}

export default function RenegotiationDialog({
  open,
  onClose,
  headroom,
  options = [],
  busyOption = null,
  onChoose,
}) {
  const rows = (options.length ? options : Object.keys(OPTION_COPY)).filter(
    (o) => OPTION_COPY[o],
  );

  // "Overcommits by 7.5h (budget 10h, load 17.5h)." — derived from the numbers
  // rather than trusting the server's prose, so the dialog can't show a stale
  // message if the plan is re-computed.
  const overBy =
    headroom && typeof headroom.free === "number" && headroom.free < 0
      ? fmtHours(-headroom.free)
      : null;
  const budget = headroom?.budgetHours;
  const total = headroom?.total;

  return (
    <CenteredDialog
      open={open}
      onClose={onClose}
      icon={AlertTriangle}
      title="That plan doesn’t fit your week"
      subtitle={
        overBy
          ? `It needs ${fmtHours(total)}h/week against a ${fmtHours(budget)}h budget — ${overBy}h over. Pick how to bring it back in.`
          : "This plan would over-commit you. Pick how to bring it back in."
      }
      maxWidth="max-w-md"
      testId="renegotiation-dialog"
      footer={
        <button
          onClick={onClose}
          disabled={!!busyOption}
          data-testid="renegotiation-cancel"
          className="h-11 px-4 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors border border-[var(--border)] rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          Cancel
        </button>
      }
    >
      <div
        aria-label="Renegotiation options"
        role="group"
        className="rounded-[12px] border border-[var(--border)] bg-[var(--bg-primary)] overflow-hidden divide-y divide-[var(--border)]"
      >
        {rows.map((opt) => {
          const copy = OPTION_COPY[opt];
          const busy = busyOption === opt;
          const disabled = !!busyOption;
          return (
            <button
              key={opt}
              type="button"
              data-testid={`renegotiation-option-${opt}`}
              aria-busy={busy ? "true" : undefined}
              disabled={disabled}
              onClick={() => onChoose?.(opt)}
              className="w-full min-h-[64px] flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--text-primary)]">
                  {copy.title}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-[var(--text-secondary)]">
                  {copy.desc}
                </span>
              </span>
              {busy ? (
                <span
                  className="h-4 w-4 shrink-0 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-[var(--text-muted)]"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>
    </CenteredDialog>
  );
}
