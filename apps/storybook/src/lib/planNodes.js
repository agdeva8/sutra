/**
 * Plan-item → plan-tree node derivation.
 *
 * Extracted from `buildPlanWorkspaceProps` in pages/Coach.js, which was the
 * only place that knew how a goal's `plan_items` become the ladder's nodes.
 * The Goal tab's per-goal plan panel needs the same mapping, and two copies of
 * it would drift — a task that ticks on one surface and not the other.
 */

// A horizon name → the ladder's level vocabulary.
const LEVEL_OF = { yearly: "year", quarterly: "quarter", monthly: "month", weekly: "week", daily: "day" };
// Level depth, for ordering coarser bands above finer ones.
const DEPTH = { year: 0, quarter: 1, month: 2, week: 3, day: 4 };

/** One goal's plan items, as ladder nodes, coarsest first. */
export function goalNodes(state, goalId) {
  return (state?.plan_items || [])
    .filter((it) => it.goal_id === goalId)
    .map((it) => ({
      id: it.id,
      level: LEVEL_OF[it.horizon] || "day",
      title: it.title,
      note: it.note || "",
      start_date: it.start_date,
      end_date: it.end_date,
      hours: typeof it.hours === "number" ? it.hours : it.weekly_hours,
      done: it.status === "done",
    }))
    .sort(
      (a, b) =>
        (DEPTH[a.level] ?? 9) - (DEPTH[b.level] ?? 9) ||
        (a.start_date || "").localeCompare(b.start_date || ""),
    );
}

/** One goal's milestones, which the ladder draws as pins. */
export function goalMilestones(state, goalId) {
  return (state?.milestones || []).filter((m) => m.goal_id === goalId);
}

/**
 * Every goal that has something to draw, as `{ id, goal, milestones, nodes }`.
 * Goals with neither nodes nor milestones are dropped — an empty ladder is
 * noise, not information.
 */
export function goalPlans(state) {
  const goals = (state?.goals || []).filter((g) => g.status !== "dropped");
  return goals
    .map((g) => ({
      id: "plan-" + g.id,
      goal: g,
      milestones: goalMilestones(state, g.id),
      nodes: goalNodes(state, g.id),
    }))
    .filter((p) => p.nodes.length > 0 || p.milestones.length > 0);
}
