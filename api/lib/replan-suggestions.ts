/**
 * Re-plan suggestions — the deterministic "you should re-plan" signal.
 *
 * Five triggers, all OPT-IN (we only ever surface an offer; the user opens
 * the `review_progress` chat and confirms proposals — nothing auto-runs):
 *
 *   1. `capacity_freed`   — a goal was dropped (or paused) recently, freeing
 *                           weekly hours while other active goals remain.
 *   2. `drift`            — an active goal's `drift_status` flipped to
 *                           `at_risk` (milestones/commitments slipping).
 *   3. `blocker_collision`— a blocker window overlaps an active goal's
 *                           `[start_date, target_date]`.
 *   4. `timetable_collision` — a goal-linked block falls outside its goal's
 *                              date window or on a blocker day.
 *
 * This module is a PURE function over inputs loaded by the dashboard read
 * model. It does NO I/O on purpose: the logic is trivially testable.
 *
 * Every suggestion carries a `prefill` string that opens the existing
 * `review_progress` scoped chat — reuse, not a new LLM flow.
 */

export type ReplanTrigger =
  | 'capacity_freed'
  | 'drift'
  | 'blocker_collision'
  | 'timetable_collision'
  | 'infeasible_edit'

export interface ReplanSuggestion {
  /** Stable key for React lists / dismissal. */
  id: string
  trigger: ReplanTrigger
  goal_id: string | null
  goal_title: string
  message: string
  freed_weekly_hours: number | null
  reasons: string[]
  blocker_id: string | null
  blocker_title: string | null
  /** Opens the `review_progress` chat with this prompt. */
  prefill: string
}

/** Trigger → the planner intent that resolves it through the new engine. */
export const REPLAN_INTENT: Record<ReplanTrigger, string> = {
  capacity_freed: 'review_progress',
  drift: 'review_progress',
  blocker_collision: 'review_progress',
  timetable_collision: 'review_progress',
  infeasible_edit: 'review_progress',
}

export interface ReplanGoalInput {
  id: string
  title: string
  status: string
  start_date?: string | null
  target_date?: string | null
  drift_status?: string | null
  weekly_hours?: number | null
}

export interface ReplanBlockerInput {
  id: string
  title: string
  start_date?: string | null
  end_date?: string | null
}

export interface ReplanAuditInput {
  id: string
  type: string
  summary?: string | null
  payload?: unknown
  created_at?: string
}

export interface ReplanMilestoneInput {
  id: string
  goal_id?: string | null
  title: string
  target_date?: string | null
  status: string
}

export interface ReplanCommitmentInput {
  id: string
  goal_id?: string | null
  text: string
  due?: string | null
  status: string
}

export interface ReplanTimetableBlockInput {
  id: string
  label: string
  goal_id?: string | null
  block_date: string
  start_time: string
  end_time: string
}

export interface ReplanSuggestionInput {
  goals: ReplanGoalInput[]
  blockers: ReplanBlockerInput[]
  /** Most-recent-first audit rows (the dashboard already loads 10). */
  recentAudit: ReplanAuditInput[]
  milestones?: ReplanMilestoneInput[]
  commitments?: ReplanCommitmentInput[]
  timetableBlocks?: ReplanTimetableBlockInput[]
  availableWeeklyHours?: number | null
  /** ISO `YYYY-MM-DD`; defaults to today (UTC). */
  today?: string
}

/** How far back a drop/pause still counts as "just freed capacity". */
const CAPACITY_WINDOW_DAYS = 7
/** Max suggestions returned — keeps the banner readable. */
const MAX_SUGGESTIONS = 5

const DROP_AUDIT_TYPES = new Set([
  'drop:goal',
  'confirm:drop_goal',
  'confirm:pause_goal',
  'confirm:update_goal',
  'update:goal',
])
const GOAL_EDIT_AUDIT_TYPES = new Set([
  'confirm:update_goal',
  'confirm:set_goal_dates',
  'update:goal',
])

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`)
  const b = Date.parse(`${bIso}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY
  return Math.round((b - a) / 86_400_000)
}

function toIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.length < 10) return null
  return v.slice(0, 10)
}

function eventFields(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.args ?? payload.fields
  return nested && typeof nested === 'object'
    ? (nested as Record<string, unknown>)
    : {}
}

export function computeReplanSuggestions(
  input: ReplanSuggestionInput,
): ReplanSuggestion[] {
  const today = input.today ?? isoToday()
  const active = input.goals.filter((g) => g.status === 'active')
  const activeById = new Map(active.map((g) => [g.id, g]))
  const out: ReplanSuggestion[] = []

  /* 1. Capacity freed — recent drop/pause with a freed-hours payload. */
  const seenGoals = new Set<string>()
  for (const a of input.recentAudit) {
    if (!DROP_AUDIT_TYPES.has(a.type)) continue
    const created = toIso(a.created_at)
    if (created && daysBetween(created, today) > CAPACITY_WINDOW_DAYS) continue

    const payload = (a.payload && typeof a.payload === 'object'
      ? (a.payload as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const freed =
      typeof payload.freed_weekly_hours === 'number'
        ? payload.freed_weekly_hours
        : null
    if (!freed || freed <= 0) continue

    const goalId = typeof payload.goal_id === 'string' ? payload.goal_id : null
    const goalTitle =
      (typeof payload.goal_title === 'string' && payload.goal_title) ||
      (typeof a.summary === 'string' ? a.summary : '') ||
      'a goal'
    const key = goalId || goalTitle
    if (seenGoals.has(key)) continue
    seenGoals.add(key)

    // Only offer a re-plan when there is something left to re-plan.
    const othersActive = active.filter((g) => g.id !== goalId)
    if (othersActive.length === 0) continue

    const auditPayload =
      a.payload && typeof a.payload === 'object'
        ? (a.payload as Record<string, unknown>)
        : {}
    const wasPaused =
      a.type === 'confirm:pause_goal' ||
      eventFields(auditPayload).status === 'paused'
    out.push({
      id: `capacity:${key}`,
      trigger: 'capacity_freed',
      goal_id: goalId,
      goal_title: goalTitle,
      message: `${wasPaused ? 'Pausing' : 'Dropping'} "${goalTitle}" freed ${freed}h/week. You have room to re-plan your remaining ${othersActive.length} goal${othersActive.length === 1 ? '' : 's'}.`,
      freed_weekly_hours: freed,
      reasons: [],
      blocker_id: null,
      blocker_title: null,
      prefill: `${wasPaused ? 'I paused' : 'I dropped'} "${goalTitle}" and freed ${freed}h/week. Re-plan my remaining goals to use that capacity — shift dates or scope, then show me what changes.`,
    })
  }

  /* 2. Drift — an active goal is at risk. */
  for (const g of active) {
    if (g.drift_status !== 'at_risk') continue
    out.push({
      id: `drift:${g.id}`,
      trigger: 'drift',
      goal_id: g.id,
      goal_title: g.title,
      message: `"${g.title}" is at risk — milestones or commitments are slipping. Re-plan it now?`,
      freed_weekly_hours: null,
      reasons: ['Milestones or commitments are behind schedule.'],
      blocker_id: null,
      blocker_title: null,
      prefill: `My goal "${g.title}" is at risk — I'm slipping behind. Re-plan it: shift dates or reduce scope, and tell me exactly what changes.`,
    })
  }

  /* 3. Blocker collision — a blocker window overlaps an active goal. */
  for (const b of input.blockers) {
    const bStart = toIso(b.start_date)
    if (!bStart) continue
    const bEnd = toIso(b.end_date) || bStart

    for (const g of active) {
      const gEnd = toIso(g.target_date)
      if (!gEnd) continue
      const gStart = toIso(g.start_date) || today
      // Overlap iff blocker starts on/before the goal ends and ends
      // on/after the goal starts.
      const overlaps = bStart <= gEnd && bEnd >= gStart
      if (!overlaps) continue
      out.push({
        id: `blocker:${b.id}:${g.id}`,
        trigger: 'blocker_collision',
        goal_id: g.id,
        goal_title: g.title,
        message: `"${b.title}" (${bStart}${bEnd !== bStart ? `–${bEnd}` : ''}) overlaps "${g.title}" (→ ${gEnd}). Re-plan around it?`,
        freed_weekly_hours: null,
        reasons: [`Blocker "${b.title}" collides with the goal window.`],
        blocker_id: b.id,
        blocker_title: b.title,
        prefill: `A blocker "${b.title}" (${bStart}${bEnd !== bStart ? `–${bEnd}` : ''}) overlaps my goal "${g.title}" (target ${gEnd}). Re-plan it — shift dates, reduce scope, or tell me to accept the slip.`,
      })
    }
  }

  /* 3.5. A goal-linked timetable block violates the goal window or a blocker. */
  for (const block of input.timetableBlocks ?? []) {
    if (!block.goal_id) continue
    const goal = activeById.get(block.goal_id)
    if (!goal) continue
    const blockDate = toIso(block.block_date)
    if (!blockDate) continue

    const goalStart = toIso(goal.start_date)
    const goalTarget = toIso(goal.target_date)
    const reasons: string[] = []
    if (goalStart && blockDate < goalStart) {
      reasons.push(`It is scheduled before the goal starts (${goalStart}).`)
    }
    if (goalTarget && blockDate > goalTarget) {
      reasons.push(`It is scheduled after the goal target date (${goalTarget}).`)
    }

    const collidingBlocker = input.blockers.find((b) => {
      const start = toIso(b.start_date)
      const end = toIso(b.end_date) || start
      return !!start && !!end && start <= blockDate && blockDate <= end
    })
    if (collidingBlocker) {
      reasons.push(`It overlaps blocker "${collidingBlocker.title}".`)
    }
    if (reasons.length === 0) continue

    out.push({
      id: `timetable:${block.id}:${goal.id}`,
      trigger: 'timetable_collision',
      goal_id: goal.id,
      goal_title: goal.title,
      message: `Scheduled block "${block.label}" on ${blockDate} conflicts with "${goal.title}". ${reasons.join(' ')} Re-plan the schedule?`,
      freed_weekly_hours: null,
      reasons,
      blocker_id: collidingBlocker?.id ?? null,
      blocker_title: collidingBlocker?.title ?? null,
      prefill: `My scheduled block "${block.label}" (${blockDate}, ${block.start_time}–${block.end_time}) conflicts with the plan for "${goal.title}". ${reasons.join(' ')} Suggest a realistic schedule or goal-date adjustment.`,
    })
  }

  /* 4. A recent goal date/hour edit made the current plan infeasible. */
  const emittedInfeasible = new Set<string>()
  const milestones = input.milestones ?? []
  const commitments = input.commitments ?? []
  const knownLoad = active.reduce(
    (sum, g) => sum + (typeof g.weekly_hours === 'number' ? g.weekly_hours : 0),
    0,
  )
  const budget = input.availableWeeklyHours ?? null

  for (const audit of input.recentAudit) {
    if (!GOAL_EDIT_AUDIT_TYPES.has(audit.type)) continue
    const created = toIso(audit.created_at)
    if (created && daysBetween(created, today) > CAPACITY_WINDOW_DAYS) continue

    const payload =
      audit.payload && typeof audit.payload === 'object'
        ? (audit.payload as Record<string, unknown>)
        : {}
    const fields = eventFields(payload)
    const goalId =
      (typeof payload.goal_id === 'string' ? payload.goal_id : null) ??
      (typeof fields.goal_id === 'string' ? fields.goal_id : null)
    if (!goalId) continue
    const goal = activeById.get(goalId)
    if (!goal || emittedInfeasible.has(goalId)) continue

    const changedDates =
      Object.prototype.hasOwnProperty.call(fields, 'target_date') ||
      Object.prototype.hasOwnProperty.call(fields, 'start_date')
    const changedHours = Object.prototype.hasOwnProperty.call(fields, 'weekly_hours')
    if (!changedDates && !changedHours) continue

    const reasons: string[] = []
    const targetDate = toIso(goal.target_date)
    const startDate = toIso(goal.start_date)
    if (changedDates) {
      if (targetDate && targetDate < today) {
        reasons.push(`Target date ${targetDate} has already passed.`)
      }
      if (targetDate && startDate && startDate > targetDate) {
        reasons.push(`Start date ${startDate} is after target date ${targetDate}.`)
      }
      const lateMilestones = milestones.filter(
        (m) =>
          m.goal_id === goalId &&
          m.status !== 'done' &&
          targetDate &&
          !!toIso(m.target_date) &&
          (toIso(m.target_date) as string) > targetDate,
      )
      if (lateMilestones.length > 0) {
        reasons.push(
          `${lateMilestones.length} open milestone${lateMilestones.length === 1 ? '' : 's'} fall after the goal target date.`,
        )
      }
      const lateCommitments = commitments.filter(
        (c) =>
          c.goal_id === goalId &&
          c.status === 'open' &&
          targetDate &&
          !!toIso(c.due) &&
          (toIso(c.due) as string) > targetDate,
      )
      if (lateCommitments.length > 0) {
        reasons.push(
          `${lateCommitments.length} open commitment${lateCommitments.length === 1 ? '' : 's'} fall after the goal target date.`,
        )
      }
    }

    if (
      changedHours &&
      budget !== null &&
      active.every((g) => typeof g.weekly_hours === 'number') &&
      knownLoad > budget
    ) {
      reasons.push(
        `Active goals now require ${knownLoad}h/week against a ${budget}h/week capacity (${round1(knownLoad - budget)}h over).`,
      )
    }

    if (reasons.length === 0) continue
    emittedInfeasible.add(goalId)
    const details = reasons.join(' ')
    out.push({
      id: `infeasible_edit:${goalId}`,
      trigger: 'infeasible_edit',
      goal_id: goalId,
      goal_title: goal.title,
      message: `The latest change made "${goal.title}" infeasible. ${details} Re-plan it?`,
      freed_weekly_hours: null,
      reasons,
      blocker_id: null,
      blocker_title: null,
      prefill: `My recent change made "${goal.title}" infeasible. ${details} Re-plan the goal and propose the date or weekly-hours changes needed to make it realistic.`,
    })
  }

  const priority: Record<ReplanTrigger, number> = {
    drift: 0,
    infeasible_edit: 1,
    timetable_collision: 2,
    blocker_collision: 3,
    capacity_freed: 4,
  }
  return out.sort((a, b) => priority[a.trigger] - priority[b.trigger]).slice(0, MAX_SUGGESTIONS)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
