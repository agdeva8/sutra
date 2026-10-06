/**
 * Goal Planner — horizon solver (whole-plan CP-SAT day placement).
 *
 * `schedule.ts` places ONE week's items. This is the plan-wide
 * generalization: given the plan's work items (each with an allowed
 * window), the user's weekly availability and blockers, it assigns each
 * item to a concrete DAY across the ENTIRE goal span in a single CP-SAT
 * model — so capacity, priority and blockers are optimised globally
 * instead of week-by-week or by naive arithmetic.
 *
 * This is the engine that replaces buildLattice's naive "one task per
 * calendar day" stamping with solver-owned, availability-aware,
 * priority-ordered dates (design: memory/scheduling-design.md §6).
 *
 * Deterministic fallback: on any runtime/solve error a greedy earliest-fit
 * allocator produces a valid (if less optimal) assignment, so a broken
 * solve can never block a plan.
 */

import type { PlanItemRow } from './scheduler'
import { weekdayOf, type Availability } from './schedule'

export interface HorizonTask {
  id: string
  title: string
  phase: string
  /** Inclusive ISO window in which this task's single sitting may land. */
  windowStart: string
  windowEnd: string
  estHours: number
  /** 1 (low) … 5 (high). Protected first when the horizon is over capacity. */
  priority: number
  /** Stable ordering hint (lower = earlier). */
  order?: number
}

export interface HorizonSolverInput {
  availability: Availability
  blockedDates?: string[]
  /** Optional hard per-day cap (hours). Defaults to the weekday availability. */
  dailyCapHours?: number
  tasks: HorizonTask[]
}

export interface HorizonSlot {
  taskId: string
  date: string
  hours: number
}

export interface HorizonResult {
  feasible: boolean
  slots: HorizonSlot[]
  unscheduled: string[]
  reason: string
  solver: 'cp-sat' | 'fallback'
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function candidateDays(
  tasks: HorizonTask[],
  availability: Availability,
  blocked: string[],
  dailyCapHours?: number,
): { dates: string[]; capTenths: number[] } {
  const blockedSet = new Set(blocked.map((d) => d.slice(0, 10)))
  let min: string | null = null
  let max: string | null = null
  for (const t of tasks) {
    const s = t.windowStart.slice(0, 10)
    const e = t.windowEnd.slice(0, 10)
    if (!min || s < min) min = s
    if (!max || e > max) max = e
  }
  if (!min || !max) return { dates: [], capTenths: [] }
  const dates: string[] = []
  const capTenths: number[] = []
  let cur = min
  for (let i = 0; i < 2000 && cur <= max; i++) {
    const cap = blockedSet.has(cur)
      ? 0
      : dailyCapHours != null
        ? dailyCapHours
        : availability[weekdayOf(cur)] ?? 0
    dates.push(cur)
    capTenths.push(Math.max(0, Math.round(cap * 10)))
    cur = isoAddDays(cur, 1)
  }
  return { dates, capTenths }
}

function windowIndices(t: HorizonTask, dates: string[]): number[] {
  const s = t.windowStart.slice(0, 10)
  const e = t.windowEnd.slice(0, 10)
  const out: number[] = []
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] >= s && dates[i] <= e) out.push(i)
  }
  return out
}

function greedy(
  input: HorizonSolverInput,
  dates: string[],
  capTenths: number[],
): HorizonResult {
  const remaining = [...capTenths]
  const slots: HorizonSlot[] = []
  const unscheduled: string[] = []
  const ordered = [...input.tasks].sort(
    (a, b) => b.priority - a.priority || (a.order ?? 0) - (b.order ?? 0),
  )
  for (const t of ordered) {
    const need = Math.max(1, Math.round((t.estHours || 0) * 10))
    let placed = false
    for (const i of windowIndices(t, dates)) {
      if (remaining[i] >= need) {
        remaining[i] -= need
        slots.push({ taskId: t.id, date: dates[i], hours: need / 10 })
        placed = true
        break
      }
    }
    if (!placed) unscheduled.push(t.id)
  }
  return {
    feasible: unscheduled.length === 0,
    slots,
    unscheduled,
    reason:
      unscheduled.length === 0
        ? 'Placed ' + slots.length + " task(s) across the plan's free hours."
        : unscheduled.length + " task(s) exceed the plan's free hours.",
    solver: 'fallback',
  }
}

/** Solve the whole-plan day assignment with CP-SAT. Falls back to `greedy`. */
export async function solveHorizon(input: HorizonSolverInput): Promise<HorizonResult> {
  if (input.tasks.length === 0) {
    return { feasible: true, slots: [], unscheduled: [], reason: 'Nothing to schedule.', solver: 'fallback' }
  }
  const blocked = (input.blockedDates ?? []).map((d) => d.slice(0, 10))
  const { dates, capTenths } = candidateDays(input.tasks, input.availability, blocked, input.dailyCapHours)
  if (dates.length === 0 || capTenths.every((c) => c <= 0)) return greedy(input, dates, capTenths)

  try {
    const cp: any = await import('or-tools-wasm/cp-sat')
    cp?.setCloudNoticeEnabled?.(false)
    const { CpModel } = cp
    const solve = cp.CpSat?.solve ?? cp.CpSolver?.solve?.bind(cp.CpSolver)
    const sum = cp.sum
    if (!CpModel || !solve) throw new Error('cp-sat unavailable')

    const m = new CpModel()
    const n = input.tasks.length
    const need = input.tasks.map((t) => Math.max(1, Math.round((t.estHours || 0) * 10)))
    const windows = input.tasks.map((t) => windowIndices(t, dates))
    const byDay = new Map<number, Array<{ t: number; local: number }>>()
    windows.forEach((w, t) => w.forEach((di, local) => {
      const list = byDay.get(di) ?? []
      list.push({ t, local })
      byDay.set(di, list)
    }))

    const b: any[][] = input.tasks.map((_, t) =>
      windows[t].map((d) => m.newBoolVar('b_' + t + '_' + d)),
    )

    for (let t = 0; t < n; t++) {
      if (b[t].length === 0) continue
      m.addLinearConstraint(sum(b[t]), 0, 1)
    }

    for (let di = 0; di < dates.length; di++) {
      const entries = byDay.get(di) ?? []
      let load: any = null
      for (const { t, local } of entries) {
        if (capTenths[di] < need[t]) {
          m.addLinearConstraint(b[t][local], 0, 0)
          continue
        }
        const term = b[t][local].times(need[t])
        load = load === null ? term : load.plus(term)
      }
      if (load !== null) m.addLinearConstraint(load, 0, capTenths[di])
    }

    let coverage: any = null
    let lateness: any = null
    for (let t = 0; t < n; t++) {
      const prio = Math.max(1, Math.min(5, input.tasks[t].priority))
      windows[t].forEach((di, local) => {
        const cov = b[t][local].times(prio * 1000)
        coverage = coverage === null ? cov : coverage.plus(cov)
        const lat = b[t][local].times(di)
        lateness = lateness === null ? lat : lateness.plus(lat)
      })
    }
    if (coverage !== null) m.maximize(lateness !== null ? coverage.minus(lateness) : coverage)

    const res = await solve(m, { numWorkers: 1 })
    if (!res.hasSolution) return greedy(input, dates, capTenths)

    const slots: HorizonSlot[] = []
    const unscheduled: string[] = []
    for (let t = 0; t < n; t++) {
      let placed = false
      for (let local = 0; local < b[t].length; local++) {
        if (Number(res.value(b[t][local])) === 1) {
          const di = windows[t][local]
          slots.push({ taskId: input.tasks[t].id, date: dates[di], hours: need[t] / 10 })
          placed = true
          break
        }
      }
      if (!placed) unscheduled.push(input.tasks[t].id)
    }
    return {
      feasible: unscheduled.length === 0,
      slots,
      unscheduled,
      reason:
        unscheduled.length === 0
          ? 'Placed ' + slots.length + " task(s) across the plan's free hours."
          : unscheduled.length + " task(s) exceed the plan's free hours.",
      solver: 'cp-sat',
    }
  } catch {
    return greedy(input, dates, capTenths)
  }
}

/**
 * Replace a lattice's *daily* rows with solver-placed sittings, plan-wide.
 * No LLM: each weekly checkpoint's work is placed on the best available day
 * by `solveHorizon`. Non-daily rows pass through untouched. Returns the
 * input unchanged when there is no availability or no weekly rows. Used by
 * the plan relay on a re-plan (goal edit / date move / blocker change).
 */
export async function planDailyFromLattice(
  rows: PlanItemRow[],
  opts: { availability: Availability; blockedDates?: string[] },
): Promise<PlanItemRow[]> {
  if (!opts.availability || Object.keys(opts.availability).length === 0) return rows
  const weeklies = rows.filter((r) => r.horizon === 'weekly' && r.start_date && r.end_date)
  if (weeklies.length === 0) return rows

  const byWeek = new Map<string, PlanItemRow[]>()
  for (const w of weeklies) {
    const key = w.start_date!.slice(0, 10)
    const list = byWeek.get(key) ?? []
    list.push(w)
    byWeek.set(key, list)
  }

  const tasks: HorizonTask[] = []
  const meta = new Map<string, PlanItemRow>()
  let i = 0
  for (const [, group] of byWeek) {
    const weeklyHours = group[0].weekly_hours
    const per = weeklyHours != null && group.length > 0 ? round1(weeklyHours / group.length) : 1
    for (const w of group) {
      const id = 'w' + i++
      tasks.push({
        id,
        title: w.title,
        phase: w.phase,
        windowStart: w.start_date!,
        windowEnd: w.end_date!,
        estHours: per > 0 ? per : 1,
        priority: 3,
        order: i,
      })
      meta.set(id, w)
    }
  }

  const result = await solveHorizon({ availability: opts.availability, blockedDates: opts.blockedDates, tasks })
  if (result.slots.length === 0) return rows

  const dailyRows: PlanItemRow[] = []
  for (const slot of result.slots) {
    const w = meta.get(slot.taskId)
    if (!w) continue
    dailyRows.push({
      horizon: 'daily',
      phase: w.phase,
      title: w.title,
      note: 'Fulfils "' + w.title + '" · ' + round1(slot.hours) + 'h',
      start_date: slot.date,
      end_date: slot.date,
      due_date: slot.date,
      weekly_hours: null,
    })
  }
  for (const id of result.unscheduled) {
    const w = meta.get(id)
    const t = tasks.find((x) => x.id === id)
    if (!w || !t) continue
    dailyRows.push({
      horizon: 'daily',
      phase: w.phase,
      title: w.title,
      note: 'Fulfils "' + w.title + '" · ' + round1(t.estHours) + 'h (over capacity)',
      start_date: t.windowStart,
      end_date: t.windowStart,
      due_date: t.windowStart,
      weekly_hours: null,
    })
  }
  dailyRows.sort((a, b) => (a.start_date! < b.start_date! ? -1 : a.start_date! > b.start_date! ? 1 : 0))

  const nonDaily = rows.filter((r) => r.horizon !== 'daily')
  return [...nonDaily, ...dailyRows]
}
