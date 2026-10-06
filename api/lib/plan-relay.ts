/**
 * Plan relay — re-materialize a goal's multi-horizon `plan_items`.
 *
 * Called after a change that invalidates a goal's schedule of record: a
 * goal edit (scope / dates / hours) or a date move. It REPLACES the goal's
 * `plan_items` (delete + insert) and moves its open milestones onto the
 * scheduler's dates — so a re-plan never duplicates or leaves a stale
 * lattice behind.
 *
 * The layout is the SAME engine that plans a goal initially: the
 * deterministic `buildLattice` for structure and the plan-wide CP-SAT
 * `planDailyFromLattice` for day placement. Best-effort: callers wrap it so
 * a relay failure can never fail the mutation that triggered it.
 *
 * Everything is dynamically imported so importing this module (e.g. from the
 * proposal executor) never runs `server-only` env validation at load — same
 * rationale as `proposal-executor.ts`.
 */

import { and, eq } from 'drizzle-orm'

const HORIZONS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function newId(prefix: string): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4)
}

function isoDate(v: unknown): string | null {
  return typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null
}

export interface RelayResult {
  written: number
  milestonesMoved: number
  solver: 'cp-sat' | 'fallback' | 'none'
}

export async function relayGoalPlan(userId: string, goalId: string): Promise<RelayResult> {
  const [{ db }, schemaMod, schedMod, solverMod] = await Promise.all([
    import('@/lib/db'),
    import('@/db/schema'),
    import('@/lib/goal-planner/scheduler'),
    import('@/lib/goal-planner/horizon-solver'),
  ])
  const { goals, milestones, planItems, blockers, users } = schemaMod

  const [goal] = await db
    .select({
      id: goals.id,
      title: goals.title,
      status: goals.status,
      startDate: goals.startDate,
      targetDate: goals.targetDate,
      weeklyHours: goals.weeklyHours,
      phaseObjectives: goals.phaseObjectives,
    })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, goalId)))
    .limit(1)
  if (!goal || goal.status === 'dropped') return { written: 0, milestonesMoved: 0, solver: 'none' }

  const ms = await db
    .select({ title: milestones.title, phase: milestones.phase, targetDate: milestones.targetDate, status: milestones.status })
    .from(milestones)
    .where(and(eq(milestones.userId, userId), eq(milestones.goalId, goalId)))
  if (ms.length === 0) return { written: 0, milestonesMoved: 0, solver: 'none' }

  const [u] = await db.select({ availability: users.availability }).from(users).where(eq(users.id, userId)).limit(1)
  const availability = (u?.availability ?? null) as Record<string, number> | null

  const bl = await db.select({ s: blockers.startDate, e: blockers.endDate }).from(blockers).where(eq(blockers.userId, userId))
  const blockedDates: string[] = []
  for (const b of bl) {
    const s = isoDate(b.s)
    if (!s) continue
    const e = isoDate(b.e) ?? s
    const end = new Date(e + 'T00:00:00.000Z')
    for (let d = new Date(s + 'T00:00:00.000Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      blockedDates.push(d.toISOString().slice(0, 10))
    }
  }

  const phases = Object.entries((goal.phaseObjectives ?? {}) as Record<string, string>).map(
    ([name, objective]) => ({ name, objective: String(objective ?? '') }),
  )

  const today = todayIso()
  const start = isoDate(goal.startDate) ?? today
  const target = isoDate(goal.targetDate) ?? addDays(start, 90)

  const scheduled = schedMod.buildLattice({
    today,
    goal_title: goal.title,
    start_date: start,
    target_date: target,
    weekly_hours: goal.weeklyHours ?? null,
    phases,
    milestones: ms.map((m) => ({ title: m.title, phase: m.phase ?? '', rationale: '' })),
  })

  let items = scheduled.items
  let solver: 'cp-sat' | 'fallback' = 'fallback'
  if (availability && Object.keys(availability).length > 0) {
    items = await solverMod.planDailyFromLattice(items, { availability, blockedDates })
    solver = 'cp-sat'
  }

  const scheduledByTitle = new Map(scheduled.milestones.map((m) => [m.title, m.target_date]))
  const rows = items
    .filter((it) => HORIZONS.includes(it.horizon))
    .map((it) => ({
      id: newId('pi'),
      userId,
      goalId,
      horizon: it.horizon,
      phase: it.phase,
      title: it.title,
      note: it.note,
      startDate: it.start_date,
      endDate: it.end_date,
      dueDate: it.due_date,
      weeklyHours: it.weekly_hours,
      status: 'open',
    }))

  let moved = 0
  await db.transaction(async (tx: any) => {
    for (const m of ms) {
      if (m.status === 'done') continue
      const nd = scheduledByTitle.get(m.title)
      if (nd && nd !== isoDate(m.targetDate)) {
        await tx
          .update(milestones)
          .set({ targetDate: nd })
          .where(and(eq(milestones.userId, userId), eq(milestones.goalId, goalId), eq(milestones.title, m.title)))
        moved += 1
      }
    }
    // Replace, never append.
    await tx.delete(planItems).where(and(eq(planItems.userId, userId), eq(planItems.goalId, goalId)))
    if (rows.length > 0) await tx.insert(planItems).values(rows)
  })

  return { written: rows.length, milestonesMoved: moved, solver }
}
