/**
 * Goal Planner — the `schedule` solver tool (CP-SAT).
 *
 * Owns the DATE placement of planned work: given a set of items and the
 * user's weekly availability, it assigns each item to a day. The LLM owns the
 * *content* (titles, scope); this module owns *when*.
 *
 * Scope of this MVP: `week` (assign items to the 7 days of one ISO week,
 * respecting per-day capacity + blocked dates + item precedence). `month` /
 * `day` reuse the same shape. See memory/scheduling-design.md §6.
 *
 * Deterministic fallback: if the CP-SAT runtime fails to load or solve, a
 * greedy allocator produces a valid (if less optimal) assignment, so a broken
 * solve can never block a plan.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** Free hours per weekday (0 = none). */
export type Availability = Partial<Record<Weekday, number>>

export interface ScheduleItem {
  id: string
  goalId?: string
  title?: string
  /** 1 (low) … 5 (high). Higher = protected first when infeasible. */
  priority: number
  /** Estimated hours for the item (fractions allowed). */
  estHours: number
  /** Precedence: items with a smaller `order` must land on an earlier-or-equal day. */
  order?: number
  /** Optional hard windows (ISO dates). */
  earliest?: string
  deadline?: string
}

export interface ScheduleInput {
  scope?: 'day' | 'week' | 'month'
  /** ISO `YYYY-MM-DD` for the Monday of the week (scope='week'). */
  weekStart: string
  availability: Availability
  items: ScheduleItem[]
  /** ISO dates that are fully unavailable (blockers). */
  blockedDates?: string[]
}

export interface ScheduledSlot {
  itemId: string
  date: string
  hours: number
}

export interface ScheduleResult {
  feasible: boolean
  slots: ScheduledSlot[]
  /** Item ids that could not be placed (over capacity). */
  unscheduled: string[]
  reason: string
  solver: 'cp-sat' | 'fallback'
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Weekday key for an ISO date (UTC-stable). */
export function weekdayOf(iso: string): Weekday {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  const idx = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  return WEEKDAYS[idx]
}

/** Day capacities (hours, in whole tenths) for the 7 days of the week. */
function dayCapacities(input: ScheduleInput): { dates: string[]; capTenths: number[] } {
  const blocked = new Set((input.blockedDates ?? []).map((d) => d.slice(0, 10)))
  const dates: string[] = []
  const capTenths: number[] = []
  for (let i = 0; i < 7; i++) {
    const date = isoAddDays(input.weekStart, i)
    const cap = blocked.has(date) ? 0 : input.availability[weekdayOf(date)] ?? 0
    dates.push(date)
    capTenths.push(Math.max(0, Math.round(cap * 10)))
  }
  return { dates, capTenths }
}

function emptyResult(reason: string): ScheduleResult {
  return { feasible: true, slots: [], unscheduled: [], reason, solver: 'fallback' }
}

/** Greedy allocator — earliest day with room; higher priority first. */
function greedy(input: ScheduleInput): ScheduleResult {
  const { dates, capTenths } = dayCapacities(input)
  const remaining = [...capTenths]
  const slots: ScheduledSlot[] = []
  const unscheduled: string[] = []
  const ordered = [...input.items].sort(
    (a, b) => b.priority - a.priority || (a.order ?? 0) - (b.order ?? 0),
  )
  for (const it of ordered) {
    const need = Math.max(1, Math.round((it.estHours || 0) * 10))
    let placed = false
    for (let d = 0; d < 7; d++) {
      const earliestDay = it.earliest ? dates.findIndex((x) => x >= it.earliest!) : 0
      if (d < Math.max(0, earliestDay)) continue
      if (it.deadline && dates[d] > it.deadline) break
      if (remaining[d] >= need) {
        remaining[d] -= need
        slots.push({ itemId: it.id, date: dates[d], hours: need / 10 })
        placed = true
        break
      }
    }
    if (!placed) unscheduled.push(it.id)
  }
  return {
    feasible: unscheduled.length === 0,
    slots,
    unscheduled,
    reason:
      unscheduled.length === 0
        ? `Placed ${slots.length} item(s) across the week's free hours.`
        : `${unscheduled.length} item(s) exceed the week's free hours.`,
    solver: 'fallback',
  }
}

/**
 * Solve the week assignment with CP-SAT. Falls back to `greedy` on any error.
 */
export async function schedulePlan(input: ScheduleInput): Promise<ScheduleResult> {
  if (input.items.length === 0) return emptyResult('Nothing to schedule.')

  const { dates, capTenths } = dayCapacities(input)
  const totalCap = capTenths.reduce((a, b) => a + b, 0)
  if (totalCap <= 0) return greedy(input)

  try {
    const cp: any = await import('or-tools-wasm/cp-sat')
    cp?.setCloudNoticeEnabled?.(false)
    const { CpModel } = cp
    const solve = cp.CpSat?.solve ?? cp.CpSolver?.solve?.bind(cp.CpSolver)
    const sum = cp.sum
    if (!CpModel || !solve) throw new Error('cp-sat unavailable')

    const m = new CpModel()
    const n = input.items.length
    // Scaled integer hours (tenths).
    const need = input.items.map((it) => Math.max(1, Math.round((it.estHours || 0) * 10)))

    const assign: any[][] = input.items.map((_, i) =>
      Array.from({ length: 7 }, (_, d) => m.newBoolVar(`a_${i}_${d}`)),
    )
    const scheduled: any[] = input.items.map((_, i) => m.newBoolVar(`s_${i}`))
    const dayOf: any[] = input.items.map((_, i) => m.newIntVar(0, 6, `day_${i}`))

    for (let i = 0; i < n; i++) {
      // sum_d assign == scheduled
      const lhs = assign[i].reduce((acc: any, b: any, d: number) => {
        const term = b.times(1)
        return acc === null ? term : acc.plus(term)
      }, null)
      m.addLinearConstraint(lhs.minus(scheduled[i]), 0, 0)
      // dayOf == sum_d d*assign  (0 when unscheduled — harmless)
      let expr: any = null
      assign[i].forEach((b: any, d: number) => {
        const term = b.times(d)
        expr = expr === null ? term : expr.plus(term)
      })
      m.addLinearConstraint(dayOf[i].minus(expr), 0, 6)
    }

    // Per-day capacity.
    for (let d = 0; d < 7; d++) {
      let load: any = null
      for (let i = 0; i < n; i++) {
        const term = assign[i][d].times(need[i])
        load = load === null ? term : load.plus(term)
      }
      m.addLinearConstraint(load, 0, capTenths[d])
    }

    // Precedence among items that share an `order` sequence: order i must not
    // land before order i-1. Softened by the scheduled flags so an
    // unscheduled item doesn't force a broken constraint.
    const byOrder = [...input.items.keys()].sort(
      (a, b) => (input.items[a].order ?? 0) - (input.items[b].order ?? 0),
    )
    for (let k = 1; k < byOrder.length; k++) {
      const prev = byOrder[k - 1]
      const cur = byOrder[k]
      // dayOf[cur] - dayOf[prev] + 6*(1-s_prev) + 6*(1-s_cur) >= 0
      //   => expr >= -12, where expr = dayOf[cur]-dayOf[prev]-6*s_prev-6*s_cur
      m.addLinearConstraint(
        dayOf[cur]
          .minus(dayOf[prev])
          .minus(scheduled[prev].times(6))
          .minus(scheduled[cur].times(6)),
        -12,
        18,
      )
    }

    // Maximize priority-weighted coverage, tie-break front-load.
    const coverage = sum(
      input.items.map((it, i) => scheduled[i].times(Math.max(1, Math.min(5, it.priority)))),
    )
    const lateness = sum(dayOf)
    m.maximize(coverage.times(100).minus(lateness))

    const res = await solve(m, { numWorkers: 1 })
    if (!res.hasSolution) return greedy(input)

    const slots: ScheduledSlot[] = []
    const unscheduled: string[] = []
    for (let i = 0; i < n; i++) {
      if (Number(res.value(scheduled[i])) === 1) {
        const d = Number(res.value(dayOf[i])) || 0
        slots.push({ itemId: input.items[i].id, date: dates[d], hours: need[i] / 10 })
      } else {
        unscheduled.push(input.items[i].id)
      }
    }
    return {
      feasible: unscheduled.length === 0,
      slots,
      unscheduled,
      reason:
        unscheduled.length === 0
          ? `Placed ${slots.length} item(s) across the week's free hours.`
          : `${unscheduled.length} item(s) exceed the week's free hours.`,
      solver: 'cp-sat',
    }
  } catch {
    return greedy(input)
  }
}

/** Convenience: project scheduled slots onto `plan_items`-style date columns. */
export function slotsToDates(result: ScheduleResult): Map<string, string> {
  return new Map(result.slots.map((s) => [s.itemId, s.date]))
}
