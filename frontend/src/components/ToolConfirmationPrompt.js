import { X, GitCommit, Pencil, Target, FileText, Calendar, Clock, Check, Loader2 } from "lucide-react";
import NavigateCard from "./NavigateCard";
import AskCard from "./AskCard";

const ACTION_LABELS = {
  create_goal: "Goal",
  update_goal: "Goal",
  set_goal_dates: "Timeline",
  add_milestone: "Milestone",
  add_blocker: "Blocker",
  add_block: "Timetable block",
  drop_goal: "Goal",
  pause_goal: "Goal",
  add_commitment: "Commitment",
  complete_commitment: "Commitment",
  update_commitment: "Commitment",
};

const HORIZON_LABELS = { weekly: "This week", short: "Short-term", medium: "Medium-term", long: "Long-term" };

/** Action-specific label for the per-item Confirm button. */
const CONFIRM_LABELS = {
  create_goal: "Create goal",
  update_goal: "Apply changes",
  set_goal_dates: "Apply dates",
  drop_goal: "Drop goal",
  pause_goal: "Pause goal",
  add_milestone: "Add milestone",
  add_commitment: "Add commitment",
  complete_commitment: "Mark done",
  update_commitment: "Update commitment",
  add_blocker: "Add blocker",
  add_block: "Add to timetable",
};

/**
 * Section badge for the body — founder feedback (Iteration 9+): the
 * proposal card body needs to read clearly as "GOAL" vs "COMMITMENT"
 * vs "MILESTONE" vs "BLOCKER" instead of a flat list of fields.
 */
const SECTION_BY_ACTION = {
  create_goal: "GOAL",
  update_goal: "GOAL",
  set_goal_dates: "GOAL",
  drop_goal: "GOAL",
  pause_goal: "GOAL",
  add_milestone: "MILESTONE",
  add_commitment: "COMMITMENT",
  complete_commitment: "COMMITMENT",
  update_commitment: "COMMITMENT",
  add_blocker: "BLOCKER",
  add_block: "SCHEDULE",
};

function SectionBadge({ section }) {
  if (!section) return null;
  return (
    <div className="flex items-center gap-1.5 mb-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] font-medium">
        {section}
      </span>
      <span className="flex-1 h-px bg-[var(--border)]" aria-hidden="true" />
    </div>
  );
}

function FieldRow({ icon: Icon, label, value, accent }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon className="w-3.5 h-3.5 text-[var(--text-muted)] mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {label && (
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--text-muted)] mb-0.5">
            {label}
          </div>
        )}
        <div className={`text-sm leading-relaxed break-words whitespace-pre-wrap ${accent ? "text-[var(--accent)]" : "text-[var(--text-primary)]"} ${!label && "font-semibold"}`}>
          {value}
        </div>
      </div>
    </div>
  );
}

/**
 * Flatten a proposal so field access works regardless of whether the
 * server wrapped fields in `args` (canonical post-parse shape from
 * `parseProposals` at api/lib/emergent/llm.ts:166) or kept them at
 * the top level (some legacy / hand-crafted test fixtures). The
 * canonical shape is `args`, but we tolerate both so a single
 * proposal object always renders the same.
 */
function flatProposal(p) {
  if (!p) return {};
  const args = p.args && typeof p.args === "object" ? p.args : {};
  return { ...args, ...p, args };
}

/**
 * Iteration 9+ structure:
 *   - Two-line header: section badge (GOAL/MILESTONE/COMMITMENT/BLOCKER)
 *     on top + "<Section>: <title>" as the second line (founder request).
 *   - Body shows the right fields per section: GOAL = title +
 *     description + deadline; MILESTONE = title + description + why +
 *     deadline; COMMITMENT = text + why added + due; BLOCKER = window.
 *   - No per-item Confirm (handled by the pinned button); Refine +
 *     Reject stay inline and open their respective modals.
 */
/**
 * DropImpactBlock — deterministic preview of what a goal drop will change,
 * attached to the proposal as `args.impact` by `/api/chat/plan`. Lets the
 * user see (and back out of) the cascade before it runs. Renders null when
 * no impact is present (e.g. the legacy SSE drop path).
 */
function DropImpactBlock({ impact }) {
  if (!impact) return null;
  const c = impact.counts || {};
  const freed = impact.freed_weekly_hours;
  const budget = impact.budget_hours;
  const lines = [
    c.commitments > 0 &&
      `${c.commitments} open commitment${c.commitments === 1 ? "" : "s"} will be closed`,
    c.milestones > 0 &&
      `${c.milestones} milestone${c.milestones === 1 ? "" : "s"} will be removed`,
    c.timetable_blocks > 0 &&
      `${c.timetable_blocks} scheduled block${c.timetable_blocks === 1 ? "" : "s"} will be removed`,
  ].filter(Boolean);

  return (
    <div
      data-testid="drop-impact"
      className="rounded-xl border border-[var(--border-accent)] bg-[var(--bg-elevated)] p-3"
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">
        What this changes
      </div>
      {lines.length > 0 ? (
        <ul className="space-y-1">
          {lines.map((l, i) => (
            <li
              key={i}
              className="flex items-start gap-2 text-[13px] text-[var(--text-secondary)]"
            >
              <span
                className="mt-1.5 h-1 w-1 rounded-full bg-[var(--warning)] shrink-0"
                aria-hidden="true"
              />
              {l}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[13px] text-[var(--text-secondary)]">
          Nothing else is attached to this goal.
        </div>
      )}
      {typeof freed === "number" && freed > 0 && (
        <div className="mt-2 pt-2 border-t border-[var(--border)] text-[13px] text-[var(--text-primary)]">
          Frees <span className="font-semibold">{freed}h/week</span>
          {typeof budget === "number"
            ? ` (load ${impact.load_before}h → ${impact.load_after}h of ${budget}h)`
            : ` (load ${impact.load_before}h → ${impact.load_after}h)`}
        </div>
      )}
    </div>
  );
}

export default function ToolConfirmationPrompt({ proposal, onConfirm, onOpenRefine, onOpenReject, onNavigate, onAnswerChoice, showConfirm = true, busy }) {
  // Read-only navigator card (general chat) — no confirm/refine/reject.
  if (proposal.action === "navigate") {
    return <NavigateCard proposal={proposal} onNavigate={onNavigate} busy={busy} />;
  }
  // Choice prompt — tappable options, not a state change.
  if (proposal.action === "ask") {
    return <AskCard proposal={proposal} onAnswer={onAnswerChoice} busy={busy} />;
  }
  const status = proposal.status || "pending";
  const isDrop = proposal.action === "drop_goal" || proposal.action === "pause_goal";
  const d = flatProposal(proposal);
  const section = SECTION_BY_ACTION[proposal.action] || "";
  const actionLabel = ACTION_LABELS[proposal.action] || proposal.action || "Proposal";
  const confirmLabel = CONFIRM_LABELS[proposal.action] || "Confirm";

  // Title used in the "<Section>: <title>" headline on the header's
  // second line. Per-section so a milestone never borrows the goal's
  // title: MILESTONE/BLOCKER use their own title, GOAL uses
  // title/new_title/goal_title, COMMITMENT uses the first line of text.
  const headlineTitle = (() => {
    if (section === "MILESTONE") return d.title || "";
    if (section === "BLOCKER") return d.title || d.text || "";
    if (section === "COMMITMENT") {
      return typeof d.text === "string" ? d.text.split("\n")[0].slice(0, 90) : "";
    }
    if (section === "SCHEDULE") return d.label || "";
    return (
      d.title ||
      d.new_title ||
      d.goal_title ||
      (typeof d.text === "string" ? d.text.split("\n")[0].slice(0, 90) : "")
    );
  })();

  // A proposal with nothing to show (no title, text, date, or reason) is
  // a no-op the model occasionally emits — don't render an empty card.
  const hasAnything =
    headlineTitle ||
    d.why ||
    d.text ||
    d.first_action ||
    d.next_action ||
    d.target_date ||
    d.due ||
    d.block_date ||
    d.start_date ||
    d.reason ||
    d.note;
  if (!hasAnything) return null;

  const showGoalFields = section === "GOAL";
  const showMilestoneFields = section === "MILESTONE";
  const showCommitmentFields = section === "COMMITMENT";
  const showBlockerFields = section === "BLOCKER";
  const showScheduleFields = section === "SCHEDULE";

  return (
    <div
      data-testid="tool-confirmation-prompt"
      data-section={section}
      className={`border rounded-2xl overflow-hidden ${status === "pending" ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-[var(--tool-bg)] my-3`}
    >
      {/* Header — two-line layout per founder feedback (Iteration 9+):
          line 1 = section badge + GitCommit icon + status; line 2 =
          "<Section>: <title>" (e.g. "Milestone: Run 10k without
          stopping"). The old "Coach wants to · Add milestone" copy
          is replaced with this named-title format. */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <GitCommit className={`w-3.5 h-3.5 ${isDrop ? "text-[var(--warning)]" : "text-[var(--accent)]"}`} />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] font-medium">
            {section || actionLabel.toUpperCase()}
          </span>
          {status !== "pending" && (
            <span className={`ml-auto font-mono text-[10px] uppercase tracking-widest ${status === "confirmed" ? "text-[var(--success)]" : "text-[var(--text-muted)]"}`}>
              {status}
            </span>
          )}
        </div>
        {headlineTitle && (
          <div data-testid="proposal-headline" className="mt-1 text-sm font-semibold text-[var(--text-primary)] whitespace-pre-wrap break-words">
            {headlineTitle}
          </div>
        )}
      </div>

      <div className="px-3 py-3 space-y-3">
        {showGoalFields && (
          <div className="space-y-2">
            <FieldRow
              icon={FileText}
              label="Description / ask"
              value={d.why}
            />
            <FieldRow
              icon={Calendar}
              label="Deadline"
              value={d.target_date || (d.horizon ? HORIZON_LABELS[d.horizon] : null)}
              accent={!!d.target_date}
            />
            {d.first_action && (
              <FieldRow icon={Target} label="First action" value={d.first_action} />
            )}
          </div>
        )}

        {showMilestoneFields && (
          <div className="space-y-2">
            <FieldRow icon={FileText} label="Description" value={d.description || d.desc || d.note} />
            <FieldRow icon={FileText} label="Why" value={d.why} />
            <FieldRow
              icon={Calendar}
              label="Deadline"
              value={d.target_date}
              accent={!!d.target_date}
            />
          </div>
        )}

        {showCommitmentFields && (
          <div className="space-y-2">
            <FieldRow icon={Target} label="Commitment" value={d.text} />
            <FieldRow icon={FileText} label="Why this was added" value={d.why || d.note || d.reason} />
            <FieldRow
              icon={Calendar}
              label="Due"
              value={d.due || d.target_date}
              accent={!!(d.due || d.target_date)}
            />
          </div>
        )}

        {showBlockerFields && (
          <div className="space-y-2">
            <FieldRow icon={FileText} label="Blocker" value={d.title || d.text} />
            <FieldRow
              icon={Calendar}
              label="Window"
              value={d.start_date ? `${d.start_date}${d.end_date ? " – " + d.end_date : ""}` : null}
              accent
            />
          </div>
        )}

        {showScheduleFields && (
          <div className="space-y-2">
            <FieldRow icon={Calendar} label="Date" value={d.block_date} accent />
            <FieldRow
              icon={Clock}
              label="Time"
              value={d.start_time && d.end_time ? `${d.start_time}–${d.end_time}` : null}
            />
            <FieldRow icon={FileText} label="Type" value={d.kind} />
            <FieldRow icon={Target} label="Goal" value={d.goal_title} />
            <FieldRow icon={FileText} label="Note" value={d.note} />
          </div>
        )}

        {section === "" && (
          <div className="space-y-2">
            <FieldRow icon={Target} label="Title" value={d.title || d.text} />
            <FieldRow icon={FileText} label="Why" value={d.why} />
            <FieldRow icon={Calendar} label="Date" value={d.target_date || d.due} accent />
          </div>
        )}

        {/* Drop preview — deterministic cascade summary from the planner
            (`args.impact`). The user sees exactly what will be cleaned up
            (and freed hours) before the destructive confirm. */}
        {proposal.action === "drop_goal" && d.impact && (
          <DropImpactBlock impact={d.impact} />
        )}

        {/* Saved notes — the user's local refinement / rejection reason.
            Reopen by tapping Refine / Reject again. Applied in a batch
            from the pinned "Refine goals" button. */}
        {proposal.refinement && (
          <div data-testid="proposal-refinement" className="rounded-xl bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-primary)]">
            <span className="font-semibold text-[var(--accent)]">Refinement:</span> {proposal.refinement}
          </div>
        )}
        {proposal.rejection && (
          <div data-testid="proposal-rejection" className="rounded-xl bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-primary)]">
            <span className="font-semibold text-[var(--danger)]">Rejection:</span> {proposal.rejection}
          </div>
        )}
      </div>

      {status !== "confirmed" && (
        <div className="border-t border-[var(--border)]">
          {/* Per-item Confirm — the only confirm path in the focused/scoped
              chats (AddGoalDialog passes showConfirm=false and uses its
              own pinned Confirm instead). */}
          {showConfirm && status === "pending" && !proposal.refinement && (
            <button
              data-testid="confirm-tool-button"
              disabled={busy}
              onClick={() => onConfirm?.()}
              className="w-full min-h-11 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold bg-[var(--accent)] text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {busy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying…
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" /> {confirmLabel}
                </>
              )}
            </button>
          )}
          <div className="flex border-t border-[var(--border)]">
            <button
              data-testid="refine-tool-button"
              disabled={busy}
              onClick={() => onOpenRefine?.(proposal)}
              className="min-h-11 flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] disabled:opacity-40 transition-colors border-r border-[var(--border)]"
            >
              <Pencil className="w-3.5 h-3.5" /> {proposal.refinement ? "Edit refinement" : "Refine"}
            </button>
            <button
              data-testid="reject-tool-button"
              disabled={busy}
              onClick={() => onOpenReject?.(proposal)}
              className="min-h-11 flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] disabled:opacity-40 transition-colors"
            >
              <X className="w-3.5 h-3.5" /> {proposal.rejection ? "Edit rejection" : "Reject"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
