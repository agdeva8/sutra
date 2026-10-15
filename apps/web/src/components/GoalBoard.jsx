import { useState } from "react";
import GoalCard from "./GoalCard";
import GoalMemoryDialog from "./GoalMemoryDialog";
import GoalPlanPanel from "./GoalPlanPanel";
import useGoalProgress from "../lib/useGoalProgress";
import { goalNodes, goalMilestones } from "../lib/planNodes";

/**
 * GoalBoard — the editable goal list, grouped by horizon.
 *
 * This is the "see and edit your goals properly" surface: each goal is a
 * `GoalCard` carrying its own actions (add step · refine · pause · memories ·
 * attach a source · drop) plus its milestone and source chips.
 *
 * Extracted out of TrackingDashboard so the cards have one definition — the
 * dashboard renders this board, and any other screen that needs the goal list
 * can render the same one instead of a copy that drifts.
 *
 * Owns the goal-memory dialog, because that dialog is opened from a card
 * action and every surface rendering the cards needs it.
 */

/**
 * The horizon vocabulary goals actually carry: `yearly` · `quarterly` ·
 * `monthly` · `weekly` · `daily` — the same lattice `plan_items` use, which
 * Coach.js maps one-to-one onto plan-tree levels.
 *
 * This list used to read ["weekly", "short", "medium", "long"], a vocabulary
 * no goal has ever carried. Every goal fell straight through the grouping, so
 * the board rendered an empty page under the tracker card. The `Other` bucket
 * in the grouping below is the guard against that happening again: a horizon
 * this list doesn't know still gets listed rather than silently dropped.
 */
// The server's goal horizons are weekly / short / medium / long (`GOAL_HORIZONS`), and the agent
// creates goals as "medium". Those were missing here, so every real goal fell into "Other".
export const HORIZON_ORDER = ["daily", "weekly", "short", "monthly", "medium", "quarterly", "long", "yearly"];
export const HORIZON_LABELS = {
  short: "Short term",
  medium: "Medium term",
  long: "Long term",
  daily: "Today",
  weekly: "This week",
  monthly: "This month",
  quarterly: "This quarter",
  yearly: "This year",
};

export default function GoalBoard({
  goals = [],
  milestones = [],
  // The full state, only so a goal's plan tree can be derived from its
  // `plan_items` when the plan panel opens. Everything else here works off the
  // two props above.
  state = null,
  onAction,
  onUploadSource,
  onAddLink,
  onDeleteSource,
  onCreated,
  onChanged,
  onOpenChat,
}) {
  const [memoryGoal, setMemoryGoal] = useState(null);
  // Where each goal stands: numbers first, then the model's verdict. Reloads when the board's state does.
  const progress = useGoalProgress(state?.generated_at);
  // The goal whose plan is open, if any. Held here rather than per-card so
  // only one plan is ever open, and so opening a second goal's plan replaces
  // the first instead of stacking panels.
  const [planGoal, setPlanGoal] = useState(null);
  const visible = goals.filter((g) => g.status !== "dropped");
  const grouped = [
    ...HORIZON_ORDER.map((h) => ({
      horizon: h,
      label: HORIZON_LABELS[h],
      goals: visible.filter((g) => g.horizon === h),
    })),
    {
      horizon: "other",
      label: "Other",
      goals: visible.filter((g) => !HORIZON_ORDER.includes(g.horizon)),
    },
  ].filter((g) => g.goals.length > 0);

  return (
    <>
      {grouped.map((group) => (
        <div key={group.horizon} data-testid={`horizon-${group.horizon}`}>
          <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {group.label}
          </div>
          <div className="rounded-2xl bg-[var(--bg-secondary)] overflow-hidden divide-y divide-[var(--border)]">
            {group.goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                milestones={milestones}
                progress={progress[g.id]}
                unscheduled={!!state && !(state.plan_items || []).some((it) => it.goal_id === g.id && it.horizon !== "milestone")}
                onScheduled={onCreated}
                onAction={onAction}
                onUploadSource={onUploadSource}
                onAddLink={onAddLink}
                onDeleteSource={onDeleteSource}
                onAddMemory={(goal) => setMemoryGoal({ id: goal.id, title: goal.title })}
                onOpenPlan={setPlanGoal}
              />
            ))}
          </div>
        </div>
      ))}

      <GoalMemoryDialog
        open={!!memoryGoal}
        goalId={memoryGoal?.id}
        goalTitle={memoryGoal?.title}
        onClose={() => setMemoryGoal(null)}
        onSaved={() => {
          setMemoryGoal(null);
          onCreated?.();
        }}
      />

      {/* The goal's plan, scoped to the goal whose button was pressed.
          One shell covers both form factors: full-width on a phone (a sheet
          that slides over the list) and a 440px panel docked right on a
          wider screen. The backdrop doubles as the dismiss target, and the
          panel carries its own close button for keyboard and pointer alike. */}
      {planGoal ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setPlanGoal(null)}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-label={`Plan for ${planGoal.title}`}
            data-testid="goal-plan-shell"
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-[var(--bg-primary)] p-4 shadow-2xl sm:w-[440px] sm:border-l sm:border-[var(--border)]"
          >
            <GoalPlanPanel
              goal={planGoal}
              nodes={goalNodes(state, planGoal.id)}
              milestones={goalMilestones(state, planGoal.id)}
              onChanged={onChanged}
              onOpenChat={onOpenChat}
              onClose={() => setPlanGoal(null)}
            />
          </aside>
        </>
      ) : null}
    </>
  );
}
