import { useState } from 'react';
import { X } from 'lucide-react';
import { PlanLadder } from './PlanHierarchy';
import { TimelineItemDetailsDialog } from './Timeline';
import { paletteFor } from './planColors';
import { api } from '../lib/api';

/**
 * GoalPlanPanel — ONE goal's plan tree.
 *
 * This is the plan tree on its own: no `PLAN TREE / CALENDAR` toggle and no
 * calendar. Timeline owns the calendar now, so Plan's duplicate month grid is
 * gone; what was worth keeping from the Plan tab is this ladder, and it is
 * surfaced from the goal it belongs to rather than from a tab of its own.
 *
 * Both callers render this one component so the tree has a single definition:
 *   - the Goal tab, as a per-goal panel (side panel on web, sheet on mobile)
 *   - `?panel=plan`, the tabless route, so old links still land on a tree
 *
 * Props are deliberately the same shape `PlanWorkspace` used, so the two can
 * be kept in step by inspection.
 */
export default function GoalPlanPanel({
  goal,
  nodes = [],
  milestones = [],
  onChanged,
  onOpenChat,
  onClose,
}) {
  const [details, setDetails] = useState(null);

  // Mirrors PlanWorkspace's node → dialog-item mapping so a task opened from
  // here renders the same details dialog as one opened from the Plan route.
  const nodeToItem = (node) => ({
    kind: node.level === 'block' ? 'block' : 'task',
    id: node.id,
    title: node.title,
    note: node.note || (node.hours ? node.hours + 'h' : ''),
    date: node.start_date || null,
    target_date: node.start_date || null,
    goal_id: goal?.id,
    status: node.done ? 'done' : 'open',
    hours: node.hours,
  });

  const toggleTask = async (id) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    try {
      // The same PATCH /plan-items the Today tab writes, so ticking a task
      // here and there cannot disagree.
      await api.updatePlanItem(id, { status: node.done ? 'open' : 'done' });
      onChanged?.();
    } catch {
      // Leave the row as it was; `onChanged` reconciles on the next refresh.
    }
  };

  // The per-task pair, worded exactly as TodayTimetable words it, so
  // "I can't do this" means the same thing on every surface.
  const scoped = (item, title, helperText) =>
    onOpenChat?.('', {
      scope: 'plan',
      refId: item?.id,
      kind: 'plan_day',
      title,
      helperText,
    });

  const help = onOpenChat
    ? {
        onCant: (item) =>
          scoped(
            item,
            `Renegotiate "${item?.text || item?.title || 'this task'}"`,
            'What part feels off? Be specific — the coach will suggest a keep / shrink / drop.',
          ),
        onAddToPlan: (item) =>
          scoped(
            item,
            `Break down "${item?.text || item?.title || 'this task'}"`,
            'Describe the smallest concrete next step and the rough when.',
          ),
      }
    : undefined;

  return (
    <div data-testid="goal-plan-panel" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          Plan
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close plan"
            title="Close plan"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <PlanLadder
          goal={goal}
          nodes={nodes}
          milestones={milestones}
          palette={paletteFor(0)}
          onHelp={help}
          onToggleTask={toggleTask}
          onItemClick={(node) => setDetails(nodeToItem(node))}
        />
      </div>

      {details ? (
        <TimelineItemDetailsDialog
          item={details}
          state={{ goals: goal ? [goal] : [], milestones }}
          onClose={() => setDetails(null)}
          onEdit={() => setDetails(null)}
          onRemove={() => setDetails(null)}
          onToggle={() => setDetails(null)}
        />
      ) : null}
    </div>
  );
}
