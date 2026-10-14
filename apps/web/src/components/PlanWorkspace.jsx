import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import GoalActionsMenu from './GoalActionsMenu';
import GoalPlanPanel from './GoalPlanPanel';

/**
 * PlanWorkspace — the `?panel=plan` route.
 *
 * Plan owns no tab any more. The plan tree lives on the Goal tab, opened per
 * goal from that goal's card; this route stays routable so old links, a
 * bookmark and a chat "take me there" still land on a tree instead of
 * dead-ending on Home.
 *
 * It is deliberately tree-only. The `PLAN TREE / CALENDAR` toggle and the
 * month grid behind it are gone — Timeline owns the calendar, and Plan's was a
 * second, thinner implementation of the same idea (a month grid with none of
 * Timeline's Day → Year zooms or nested goal spans). What was worth keeping
 * from this route is the ladder, so the ladder is all it renders.
 *
 * The tree itself is `GoalPlanPanel`, the same component the Goal tab opens in
 * its side panel, so the per-task affordances ("I can't do this" / "Break it
 * down with the coach"), the task tick and the details dialog have one
 * implementation rather than two that drift.
 */
export function PlanWorkspace(props) {
  const {
    plans, goals = [], milestones = [], goal, nodes,
    // Goal-action plumbing, forwarded to GoalActionsMenu. All optional — the
    // menu falls back to a navigation or its own dialog where it can.
    // `onAction` is Coach.js' `openAction`, which opens the shared
    // ActionPromptModal confirmation for edit / milestone / pause / drop.
    onAction, onOpenMemories, onOpenSources, onUploadFile, onAddLink, onChanged, onOpenChat,
  } = props;

  const list = plans && plans.length
    ? plans
    : (goal ? [{ id: 'p0', goal, nodes: nodes || [], milestones: milestones || [] }] : []);
  const [idx, setIdx] = useState(0);
  const safeIdx = Math.max(0, Math.min(idx, list.length - 1));
  const current = list[safeIdx];

  if (!current) {
    return (
      <div data-testid="plan-workspace" className="mx-auto w-full max-w-[820px] px-4 py-6 sm:px-6">
        <p className="text-[14px] text-[var(--text-secondary)]">
          Nothing planned yet. Add a goal and its steps and they will appear here.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="plan-workspace"
      className="mx-auto w-full max-w-[820px] space-y-4 px-4 py-5 sm:px-6 sm:py-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {list.length > 1 ? (
          // The pager is why this route still exists next to the Goal tab's
          // side panel: it walks every goal's plan in one place.
          <div className="inline-flex items-center gap-1" role="group" aria-label="Plan pager">
            <button
              type="button"
              onClick={() => setIdx(Math.max(0, safeIdx - 1))}
              disabled={safeIdx === 0}
              aria-label="Previous goal's plan"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              {safeIdx + 1} / {list.length}
            </span>
            <button
              type="button"
              onClick={() => setIdx(Math.min(list.length - 1, safeIdx + 1))}
              disabled={safeIdx === list.length - 1}
              aria-label="Next goal's plan"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <span />
        )}

        {/* The single goal affordance for this route. */}
        {current.goal ? (
          <GoalActionsMenu
            goal={current.goal}
            onAction={onAction}
            onOpenMemories={onOpenMemories}
            onOpenSources={onOpenSources}
            onUploadFile={onUploadFile}
            onAddLink={onAddLink}
            onChanged={onChanged}
          />
        ) : null}
      </div>

      <GoalPlanPanel
        goal={current.goal}
        nodes={current.nodes}
        milestones={current.milestones}
        onChanged={onChanged}
        onOpenChat={onOpenChat}
      />
    </div>
  );
}

export default PlanWorkspace;
