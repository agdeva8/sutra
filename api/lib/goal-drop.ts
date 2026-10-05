/**
 * Goal-drop cascade + impact preview.
 *
 * Single owner of "what happens when a goal is dropped":
 *   - `resolveGoalRef`        — resolve a goal from `goal_id` / `goal_title`
 *                               (moved here from proposal-executor.ts so the
 *                               executor, the DELETE route, and the planner
 *                               route all share one resolver).
 *   - `computeGoalDropImpact` — pure read: what will be cleaned up + how much
 *                               weekly capacity the drop frees.
 *   - `dropImpactSentence`    — deterministic one-liner for the coach prose.
 *   - `applyGoalDropCascade`  — one transaction: flip the goal to `dropped`,
 *                               close its open commitments, delete its
 *                               milestones + timetable blocks, write one
 *                               audit row carrying the counts.
 *
 * Why this file exists: before it, dropping a goal only flipped
 * `goals.status`; the goal's commitments stayed `open`, its milestones and
 * scheduled blocks stayed visible, and the freed capacity never surfaced.
 * See memory/HLD-drop-goal-cascade.md.
 *
 * The DB/schema pair is passed in (never imported at module top-level) so
 * this module stays importable from vitest without a boot-validated env —
 * same rationale as proposal-executor.ts.
 */

import { and, eq, sql } from 'drizzle-orm'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface GoalRef {
  goalId: string
  goalTitle: string
}

export interface DropImpactItemMilestone {
  id: string
  title: string
  target_date: string | null
}
export interface DropImpactItemBlock {
  id: string
  label: string
  block_date: string
  start_time: string
  end_time: string
}

export interface GoalDropImpact {
  goal_id: string
  goal_title: string
  milestones: DropImpactItemMilestone[]
  timetable_blocks: DropImpactItemBlock[]
  counts: {
    milestones: number
    timetable_blocks: number
  }
  /** `goals.weekly_hours` — null when never estimated. */
  freed_weekly_hours: number | null
  /** Σ active goals' weekly_hours (KNOWN estimates only). */
  load_before: number
  /** load_before − freed (floored at 0). */
  load_after: number
  /** `users.available_weekly_hours`; null = no budget set. */
  budget_hours: number | null
  /** Non-dropped goals other than the one being dropped. */
  other_active_goals: number
}

/** Cap on the item lists returned for display / prompt injection. */
const MAX_LIST = 10

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/* -------------------------------------------------------------------------- */
/* Goal reference resolver                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a goal from a tool's args. The system prompt advertises
 * `goal_title` (the model never sees goal IDs), but every row has a stable
 * `goal_xxx` ID, so prefer `goal_id` when a caller supplies one.
 *
 * Title matching is exact-case-insensitive trimmed equality, then a guarded
 * substring fallback (`needle.length >= 6`) so a goal called "Runn" never
 * lands on "Running".
 */
export async function resolveGoalRef(
  db: any,
  schema: any,
  userId: string,
  args: Record<string, any>,
): Promise<GoalRef | null> {
  const idRaw = typeof args.goal_id === 'string' ? args.goal_id.trim() : ''
  const titleRaw =
    typeof args.goal_title === 'string' ? args.goal_title.trim() : ''

  if (idRaw) {
    const rows = await db
      .select({ id: schema.goals.id, title: schema.goals.title })
      .from(schema.goals)
      .where(and(eq(schema.goals.userId, userId), eq(schema.goals.id, idRaw)))
      .limit(1)
    if (rows.length) return { goalId: rows[0].id, goalTitle: rows[0].title }
    // Fall through to title lookup so a stale ID still has a chance.
  }

  if (titleRaw) {
    const all = await db
      .select({ id: schema.goals.id, title: schema.goals.title })
      .from(schema.goals)
      .where(eq(schema.goals.userId, userId))
      .limit(500)
    const needle = titleRaw.toLowerCase()
    const exact = all.find(
      (g: { title: string }) => g.title.trim().toLowerCase() === needle,
    )
    if (exact) return { goalId: exact.id, goalTitle: exact.title }
    const partial = all.find(
      (g: { title: string }) =>
        needle.length >= 6 && g.title.trim().toLowerCase().includes(needle),
    )
    if (partial) return { goalId: partial.id, goalTitle: partial.title }
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* Impact preview                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read-only. Enumerates exactly what `applyGoalDropCascade` will do to this
 * goal, plus how much weekly capacity the drop frees. Safe to call
 * repeatedly (e.g. when building a proposal card) — it writes nothing.
 */
export async function computeGoalDropImpact(
  db: any,
  schema: any,
  userId: string,
  ref: GoalRef,
): Promise<GoalDropImpact> {
  const [goalRows, mileRows, blockRows, allGoalRows, userRows] =
    await Promise.all([
      db
        .select({
          id: schema.goals.id,
          title: schema.goals.title,
          weeklyHours: schema.goals.weeklyHours,
          status: schema.goals.status,
        })
        .from(schema.goals)
        .where(
          and(eq(schema.goals.userId, userId), eq(schema.goals.id, ref.goalId)),
        )
        .limit(1),
      db
        .select({
          id: schema.milestones.id,
          title: schema.milestones.title,
          targetDate: schema.milestones.targetDate,
        })
        .from(schema.milestones)
        .where(
          and(
            eq(schema.milestones.userId, userId),
            eq(schema.milestones.goalId, ref.goalId),
          ),
        )
        .limit(500),
      db
        .select({
          id: schema.timetableBlocks.id,
          label: schema.timetableBlocks.label,
          blockDate: schema.timetableBlocks.blockDate,
          startTime: schema.timetableBlocks.startTime,
          endTime: schema.timetableBlocks.endTime,
        })
        .from(schema.timetableBlocks)
        .where(
          and(
            eq(schema.timetableBlocks.userId, userId),
            eq(schema.timetableBlocks.goalId, ref.goalId),
          ),
        )
        .limit(500),
      db
        .select({
          id: schema.goals.id,
          weeklyHours: schema.goals.weeklyHours,
          status: schema.goals.status,
        })
        .from(schema.goals)
        .where(eq(schema.goals.userId, userId))
        .limit(500),
      db
        .select({ availableWeeklyHours: schema.users.availableWeeklyHours })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1),
    ])

  const goal = goalRows[0]
  const goalWeeklyHours: number | null =
    goal && typeof goal.weeklyHours === 'number' ? goal.weeklyHours : null

  // Capacity math mirrors Stage 3.5 headroom: only ACTIVE goals count, and
  // null estimates are excluded from the sum.
  const active = allGoalRows.filter(
    (g: { status: string }) => g.status === 'active',
  )
  const loadBefore = round1(
    active
      .filter((g: { weeklyHours: number | null }) => typeof g.weeklyHours === 'number')
      .reduce(
        (sum: number, g: { weeklyHours: number | null }) =>
          sum + (g.weeklyHours ?? 0),
        0,
      ),
  )
  const freed = goalWeeklyHours
  const loadAfter = round1(Math.max(0, loadBefore - (freed ?? 0)))
  const otherActive = active.filter(
    (g: { id: string }) => g.id !== ref.goalId,
  ).length

  const hhmm = (t: unknown) =>
    typeof t === 'string' && t.length >= 5 ? t.slice(0, 5) : String(t ?? '')

  return {
    goal_id: ref.goalId,
    goal_title: goal?.title ?? ref.goalTitle,
    milestones: mileRows.slice(0, MAX_LIST).map((m: any) => ({
      id: m.id,
      title: m.title,
      target_date: m.targetDate ?? null,
    })),
    timetable_blocks: blockRows.slice(0, MAX_LIST).map((b: any) => ({
      id: b.id,
      label: b.label,
      block_date: b.blockDate,
      start_time: hhmm(b.startTime),
      end_time: hhmm(b.endTime),
    })),
    counts: {
      milestones: mileRows.length,
      timetable_blocks: blockRows.length,
    },
    freed_weekly_hours: freed,
    load_before: loadBefore,
    load_after: loadAfter,
    budget_hours: userRows[0]?.availableWeeklyHours ?? null,
    other_active_goals: otherActive,
  }
}

/** Deterministic sentence the coach can surface before the user commits. */
export function dropImpactSentence(impact: GoalDropImpact): string {
  const c = impact.counts
  const parts: string[] = []
  if (c.milestones > 0)
    parts.push(`${c.milestones} milestone${c.milestones === 1 ? '' : 's'}`)
  if (c.timetable_blocks > 0)
    parts.push(
      `${c.timetable_blocks} scheduled block${c.timetable_blocks === 1 ? '' : 's'}`,
    )

  const cleanup =
    parts.length === 0
      ? 'nothing else is attached'
      : `this closes ${parts.join(', ')}`
  const freed =
    impact.freed_weekly_hours && impact.freed_weekly_hours > 0
      ? ` and frees ${impact.freed_weekly_hours}h/week`
      : ''
  return `Dropping "${impact.goal_title}" will clean up its plan (${cleanup})${freed}.`
}

/* -------------------------------------------------------------------------- */
/* Cascade                                                                    */
/* -------------------------------------------------------------------------- */

export interface CascadeResult {
  impact: GoalDropImpact
  /** Human-readable confirmation line for the result/toast. */
  result: string
}

/**
 * Apply the drop in one transaction.
 *
 * @param opts.auditType  `confirm:drop_goal` (proposal path) or `drop:goal`
 *                        (direct DELETE path).
 * @param opts.reason     optional free-text reason from the proposal args.
 */
export async function applyGoalDropCascade(
  db: any,
  schema: any,
  userId: string,
  ref: GoalRef,
  opts: { auditType: string; reason?: string },
): Promise<CascadeResult> {
  // Capture the impact on the live rows BEFORE the deletes so both the
  // result line and the audit payload are accurate.
  const impact = await computeGoalDropImpact(db, schema, userId, ref)

  await db.transaction(async (tx: any) => {
    await tx
      .update(schema.goals)
      .set({ status: 'dropped', updatedAt: new Date() })
      .where(
        and(eq(schema.goals.userId, userId), eq(schema.goals.id, ref.goalId)),
      )

    // Remove plan scaffolding (milestones + scheduled blocks).
    await tx
      .delete(schema.milestones)
      .where(
        and(
          eq(schema.milestones.userId, userId),
          eq(schema.milestones.goalId, ref.goalId),
        ),
      )
    await tx
      .delete(schema.timetableBlocks)
      .where(
        and(
          eq(schema.timetableBlocks.userId, userId),
          eq(schema.timetableBlocks.goalId, ref.goalId),
        ),
      )

    await tx.insert(schema.auditLog).values({
      id: newId('audit'),
      userId,
      type: opts.auditType,
      summary: resultLine(ref.goalTitle, impact, opts.reason),
      payload: {
        goal_id: ref.goalId,
        goal_title: ref.goalTitle,
        reason: opts.reason ?? null,
        cleaned: impact.counts,
        freed_weekly_hours: impact.freed_weekly_hours,
        load_before: impact.load_before,
        load_after: impact.load_after,
      },
    })
  })

  return { impact, result: resultLine(ref.goalTitle, impact, opts.reason) }
}

/** Shared summary builder for the audit row + user-facing result. */
function resultLine(
  goalTitle: string,
  impact: GoalDropImpact,
  reason?: string,
): string {
  const c = impact.counts
  const cleaned: string[] = []
  if (c.milestones > 0)
    cleaned.push(`${c.milestones} milestone${c.milestones === 1 ? '' : 's'}`)
  if (c.timetable_blocks > 0)
    cleaned.push(
      `${c.timetable_blocks} scheduled block${c.timetable_blocks === 1 ? '' : 's'}`,
    )

  const cleanedTxt = cleaned.length ? `; cleaned up ${cleaned.join(', ')}` : ''
  const freedTxt =
    impact.freed_weekly_hours && impact.freed_weekly_hours > 0
      ? `; freed ${impact.freed_weekly_hours}h/week`
      : ''
  const reasonTxt = reason ? ` (${reason})` : ''
  return `Dropped goal '${goalTitle}'${reasonTxt}${cleanedTxt}${freedTxt}`
}
