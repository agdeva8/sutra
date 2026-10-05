/**
 * Drift detection service (Iteration 10, effect 5.5).
 *
 * Snapshot-based: given a user's current goals, milestones and commitments it
 * computes each active goal's drift via the pure `computeDrift`, and writes
 * `goals.drift_status` when it changes (auditing the transition). Called after
 * every relevant commitment change / daily-log save / blocker change, and
 * once per user per UTC day when the dashboard read model misses its cache
 * (so a deadline that passed while the user was away is detected at return).
 *
 * Deliberately cheap and synchronous — one user-scoped read of three tables,
 * no worker. The "completed_hours < 60% of target_hours" rule is not computable
 * (nothing tracks actual hours); see `lib/goal-planner/drift.ts`.
 */

import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { goals, milestones } from '@/db/schema'
import { AUDIT_TYPES, writeAudit } from '@/lib/audit'
import { computeDrift } from '@/lib/goal-planner/drift'

export type DriftStatus = 'on_track' | 'at_risk'

export interface DriftTransition {
  goalId: string
  title: string
  from: DriftStatus
  to: DriftStatus
  reasons: string[]
}

/**
 * Recompute drift for a user's active goals (optionally just `goalIds`) and
 * persist any status changes. Returns the transitions that occurred.
 *
 * Never throws for a per-goal computation issue — callers wrap this best-effort
 * so a drift failure cannot fail the mutation that triggered it.
 */
export async function recomputeGoalDrift(
  userId: string,
  goalIds?: string[],
): Promise<DriftTransition[]> {
  const today = new Date().toISOString().slice(0, 10)

  const goalWhere =
    goalIds && goalIds.length > 0
      ? and(eq(goals.userId, userId), inArray(goals.id, goalIds))
      : eq(goals.userId, userId)

  const goalRows = await db
    .select({
      id: goals.id,
      title: goals.title,
      status: goals.status,
      driftStatus: goals.driftStatus,
    })
    .from(goals)
    .where(goalWhere)

  const targets = goalRows.filter((g) => g.status === 'active')
  if (targets.length === 0) return []

  const milestoneRows = await db
    .select({
      goalId: milestones.goalId,
      title: milestones.title,
      targetDate: milestones.targetDate,
      status: milestones.status,
    })
    .from(milestones)
    .where(eq(milestones.userId, userId))

  const transitions: DriftTransition[] = []

  for (const g of targets) {
    const ms = milestoneRows
      .filter((m) => m.goalId === g.id)
      .map((m) => ({ title: m.title, targetDate: m.targetDate, status: m.status }))
    const { status, reasons } = computeDrift({ today, milestones: ms })
    const from = g.driftStatus as DriftStatus
    if (status === from) continue

    await db.transaction(async (tx: any) => {
      await tx
        .update(goals)
        .set({ driftStatus: status, updatedAt: new Date() })
        .where(eq(goals.id, g.id))
      await writeAudit(tx, {
        userId,
        type: AUDIT_TYPES.DRIFT_GOAL,
        summary:
          status === 'at_risk'
            ? `Drift: '${g.title}' now at risk`
            : `Drift cleared: '${g.title}' back on track`,
        payload: { goal_id: g.id, from, to: status, reasons },
      })
    })

    transitions.push({ goalId: g.id, title: g.title, from, to: status, reasons })
  }

  return transitions
}
