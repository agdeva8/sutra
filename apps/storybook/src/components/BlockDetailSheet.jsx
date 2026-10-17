import { useState } from "react";
import { Pencil, Target, Trash2, X } from "lucide-react";
import { KIND_META, TASK_STATES, blockColor, milestoneOverdue, taskState, whenLabel } from "../constants/blockKinds";

const STATE_LABEL = { open: "To do", done: "Done", partial: "Partly done", skip: "Skipped" };

/**
 * The tap target of every block: a bottom sheet with what it is, its goal, and the actions that
 * kind actually has. This is where the CRUD lives — edit, delete, tick states, mark reached — so
 * the card itself stays a clean target.
 *
 * Per the settled design, a Milestone leads with "Mark reached" (its one action) and keeps "Open
 * goal" as the deeper link; a Task's three tick states live here rather than behind a long-press;
 * Event and Task can attach or drop a goal, Away and Milestone cannot (Away is never goal work, a
 * Milestone already requires its goal).
 */
export default function BlockDetailSheet({
  block,
  goalTitle,
  goals = [],
  onClose,
  onEdit,
  onDelete,
  onUpdate,
  onOpenGoal,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!block) return null;
  const kind = block.block_kind;
  const meta = KIND_META[kind];
  const when = whenLabel(block);
  const overdue = milestoneOverdue(block);
  const state = taskState(block);
  const color = blockColor(block);

  const setTaskState = (next) => onUpdate?.({ ...block, state: next, done: next === "done" });
  const attachGoal = (goalId) => onUpdate?.({ ...block, goal_id: goalId || null });

  const btn =
    "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]";
  const btnPrimary = `${btn} bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90`;
  const btnQuiet = `${btn} bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]`;
  const btnDanger = `${btn} bg-[var(--danger)] text-white hover:opacity-90`;

  return (
    <div role="dialog" aria-modal="true" data-testid="block-detail" onClick={onClose}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
      <div onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-auto rounded-t-2xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4 sm:rounded-2xl">
        <header className="mb-3 flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--bg-primary)]"
              style={{ background: color }}
            >
              {meta.glyph}
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-[16px] font-semibold text-[var(--text-primary)]">{block.title}</h3>
              <p className="text-[11px] text-[var(--text-muted)]">
                {meta.label}
                {overdue ? " · overdue" : ""}
                {block.reached ? " · reached" : ""}
                {block.repeat ? " · repeats" : ""}
                {block.alert_before != null ? " · alert set" : ""}
              </p>
            </div>
          </div>
          <button type="button" aria-label="Close" data-testid="block-detail-close" onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--bg-primary)]">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <dl className="mb-3 space-y-1.5 text-[13px]">
          {when && (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-[var(--text-muted)]">When</dt>
              <dd className="text-[var(--text-primary)]">{when}</dd>
            </div>
          )}
          <div className="flex items-center gap-2">
            <dt className="w-20 shrink-0 text-[var(--text-muted)]">Goal</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              {goalTitle ? (
                <>
                  <span className="truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{ background: `color-mix(in srgb, ${color} 16%, var(--bg-primary))`, color }}>
                    {goalTitle}
                  </span>
                  {(kind === "event" || kind === "task") && (
                    <button type="button" data-testid="block-detach-goal" onClick={() => attachGoal("")}
                      className="text-[11px] text-[var(--text-muted)] underline hover:text-[var(--text-primary)]">
                      Detach
                    </button>
                  )}
                </>
              ) : (
                <span className="text-[var(--text-muted)]">None</span>
              )}
            </dd>
          </div>
          {(kind === "event" || kind === "task") && (
            <div className="flex items-center gap-2">
              <dt className="w-20 shrink-0 text-[var(--text-muted)]" />
              <dd>
                <select
                  aria-label="Attach goal"
                  data-testid="block-attach-goal"
                  value={block.goal_id || ""}
                  onChange={(e) => attachGoal(e.target.value)}
                  className="min-h-11 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-xs text-[var(--text-primary)]"
                >
                  <option value="">Attach a goal…</option>
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>{g.title}</option>
                  ))}
                </select>
              </dd>
            </div>
          )}
          {block.note || block.description ? (
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-[var(--text-muted)]">Note</dt>
              <dd className="text-[var(--text-primary)]">{block.note || block.description}</dd>
            </div>
          ) : null}
        </dl>

        {/* The one action this kind exists for, kept above the CRUD row. */}
        {kind === "task" && (
          <section className="mb-3">
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Progress</h4>
            <div className="flex gap-2">
              {TASK_STATES.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid={`block-state-${s}`}
                  aria-pressed={state === s}
                  onClick={() => setTaskState(s)}
                  className={`min-h-11 flex-1 rounded-xl px-2 text-xs font-medium transition-colors ${
                    state === s
                      ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                      : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  }`}
                >
                  {STATE_LABEL[s]}
                </button>
              ))}
            </div>
          </section>
        )}
        {kind === "milestone" && (
          <section className="mb-3 flex gap-2">
            <button type="button" data-testid="block-mark-reached"
              onClick={() => onUpdate?.({ ...block, reached: !block.reached })}
              className={block.reached ? btnQuiet : btnPrimary}>
              {block.reached ? "Mark not reached" : "Mark reached"}
            </button>
            <button type="button" data-testid="block-open-goal" onClick={() => onOpenGoal?.(block.goal_id)} className={btnQuiet}>
              <Target className="h-3.5 w-3.5" aria-hidden="true" /> Open goal
            </button>
          </section>
        )}

        <footer className="mt-2 flex items-center gap-2">
          <button type="button" data-testid="block-edit" onClick={() => onEdit?.(block)} className={btnQuiet}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
          </button>
          {confirmDelete ? (
            <>
              <button type="button" data-testid="block-delete-confirm" onClick={() => onDelete?.(block)} className={btnDanger}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete for good
              </button>
              <button type="button" data-testid="block-delete-cancel" onClick={() => setConfirmDelete(false)} className={btnQuiet}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" data-testid="block-delete" onClick={() => setConfirmDelete(true)} className={btnQuiet}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
