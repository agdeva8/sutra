/**
 * Goal Planner — week → distinct days (decompose).
 *
 * The LLM owns the *content* of a week's work: turn a weekly checkpoint into
 * distinct, verb-led daily steps. The CP-SAT `schedulePlan` then owns *which
 * day* each step lands on, using the user's availability.
 *
 * Fallback: if the LLM step fails or returns junk, a deterministic split
 * produces one step per available day (`<week> — step k/N`), so a failed
 * decompose never blocks a plan. See memory/scheduling-design.md.
 */

import { z } from 'zod'

import type { CompleteFn } from './orchestrator'
import type { PlanItemRow } from './scheduler'
import {
  schedulePlan,
  WEEKDAYS,
  type Availability,
  type ScheduleItem,
  type Weekday,
} from './schedule'

const DecomposeSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(1).max(90),
        hours: z.number().min(0.25).max(12).optional(),
      }),
    )
    .min(1)
    .max(7),
})
type DecomposeStep = z.infer<typeof DecomposeSchema>['steps'][number]

export function decomposePrompt(args: {
  weekLabel: string
  objective?: string
  availableDays: Weekday[]
  weeklyHours: number
}): string {
  return `Voice: precise, concrete, action-first. No filler.
Split this week's outcome into ${args.availableDays.length} distinct daily
actions (one per available day: ${args.availableDays.join(', ')}).
Outcome: "${args.weekLabel}"${args.objective ? `\nContext: ${args.objective}` : ''}
Weekly time budget: ~${args.weeklyHours}h.

Rules:
- Each step is a short, verb-led action a person can do in one sitting
  (e.g. "Read the caching chapter", "Implement a cache"), not a restatement of
  the outcome. Distinct steps — do not repeat.
- Order them so earlier steps enable later ones.
- Optional per-step "hours" (0.25–12); if omitted the budget is split evenly.
Return { "steps": [ { "title": "...", "hours": 1.5 }, ... ] }`
}

export interface DecomposedDay {
  date: string
  title: string
  hours: number
}

function fallbackSteps(weekLabel: string, n: number): DecomposeStep[] {
  const count = Math.max(1, n)
  return Array.from({ length: count }, (_, i) => ({
    title: `${weekLabel} — step ${i + 1}/${count}`,
  }))
}

/**
 * Decompose one week into distinct days via the LLM, then assign each step to
 * a day with the CP-SAT scheduler. Falls back to a deterministic split.
 */
export async function decomposeAndScheduleWeek(args: {
  weekStart: string
  weekLabel: string
  objective?: string
  weeklyHours: number
  availability: Availability
  blockedDates?: string[]
  provider: Parameters<CompleteFn>[0]['provider']
  complete: CompleteFn
}): Promise<{ days: DecomposedDay[]; solver: 'cp-sat' | 'fallback' }> {
  const blocked = new Set((args.blockedDates ?? []).map((d) => d.slice(0, 10)))
  const availableDays = WEEKDAYS.filter((d, i) => {
    const date = isoAdd(args.weekStart, i)
    return !blocked.has(date) && (args.availability[d] ?? 0) > 0
  }) as Weekday[]

  // No capacity anywhere this week → nothing to place.
  if (availableDays.length === 0) return { days: [], solver: 'fallback' }

  let steps: DecomposeStep[]
  try {
    const { object } = await args.complete({
      provider: args.provider,
      schema: DecomposeSchema,
      prompt: decomposePrompt({
        weekLabel: args.weekLabel,
        objective: args.objective,
        availableDays,
        weeklyHours: args.weeklyHours,
      }),
    } as any)
    steps = object.steps
  } catch {
    steps = fallbackSteps(args.weekLabel, availableDays.length)
  }
  if (!steps.length) steps = fallbackSteps(args.weekLabel, availableDays.length)

  const perStep =
    steps.length > 0 ? round1(args.weeklyHours / steps.length) : args.weeklyHours
  const items: ScheduleItem[] = steps.map((s, i) => ({
    id: `s${i}`,
    title: s.title,
    priority: 3,
    estHours: s.hours ?? perStep,
    order: i,
  }))

  const result = await schedulePlan({
    scope: 'week',
    weekStart: args.weekStart,
    availability: args.availability,
    blockedDates: args.blockedDates,
    items,
  })

  const byId = new Map(steps.map((s, i) => [`s${i}`, s]))
  const days: DecomposedDay[] = result.slots
    .map((slot) => {
      const s = byId.get(slot.itemId)
      return s ? { date: slot.date, title: s.title, hours: slot.hours } : null
    })
    .filter((d): d is DecomposedDay => !!d)
    .sort((a, b) => (a.date < b.date ? -1 : 1))

  return { days, solver: result.solver }
}

/**
 * Replace the lattice's cloned *daily* rows with distinct, availability-
 * scheduled day tasks for each weekly checkpoint. Non-daily rows pass through
 * untouched. Returns the input unchanged if there is no availability or no
 * weekly rows, so callers can use it unconditionally.
 */
export async function decomposePlanItems(
  rows: PlanItemRow[],
  opts: {
    availability: Availability
    blockedDates?: string[]
    provider: Parameters<CompleteFn>[0]['provider']
    complete: CompleteFn
  },
): Promise<PlanItemRow[]> {
  if (!opts.availability || Object.keys(opts.availability).length === 0) return rows
  const weeklies = rows.filter((r) => r.horizon === 'weekly' && r.start_date)
  if (weeklies.length === 0) return rows

  const dailyRows: PlanItemRow[] = []
  for (const w of weeklies) {
    try {
      const { days } = await decomposeAndScheduleWeek({
        weekStart: w.start_date!,
        weekLabel: w.title,
        objective: w.note || undefined,
        weeklyHours: w.weekly_hours ?? 0,
        availability: opts.availability,
        blockedDates: opts.blockedDates,
        provider: opts.provider,
        complete: opts.complete,
      })
      for (const d of days) {
        dailyRows.push({
          horizon: 'daily',
          phase: w.phase,
          title: d.title,
          note: `Fulfils "${w.title}" · ${d.hours}h`,
          start_date: d.date,
          end_date: d.date,
          due_date: d.date,
          weekly_hours: null,
        })
      }
    } catch {
      /* fall through: keep the lattice's own daily rows for this week */
      dailyRows.length = 0
      return rows
    }
  }

  const nonDaily = rows.filter((r) => r.horizon !== 'daily')
  return [...nonDaily, ...dailyRows]
}

function isoAdd(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
