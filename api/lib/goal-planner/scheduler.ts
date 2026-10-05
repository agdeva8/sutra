/**
 * Goal Planner — deterministic scheduler (the "solver" role).
 *
 * The deterministic counterpart to the LLM's Stage 3. The LLM keeps
 * semantics — milestone titles, which phase each belongs to, phase
 * objectives, why, weekly_hours — and this module owns EVERY date and
 * span on the timeline. It lays the plan out as a multi-horizon lattice:
 *
 *   yearly      → the goal span [start_date, target_date]
 *   quarterly   → one span per phase (2-4), partitioning the goal span
 *   monthly     → milestones, dated inside each phase's EFFECTIVE window
 *   weekly      → derived checkpoints inside each phase's effective window
 *   daily       → the plan's commitments (smallest next actions)
 *
 * Buffer rule (locked with the founder): every horizon keeps a 20% tail
 * buffer. A phase schedules its milestones/weeks into the first 80% of its
 * span; the last 20% is unallocated slack, so a slip at one level absorbs
 * into that level's buffer before it propagates up to the next. The same
 * 80/20 split applies per phase span. Capacity (weekly_hours vs
 * available_weekly_hours) is still checked by `headroom.ts` — this module
 * only lays out the timeline.
 *
 * Pure module: no DB, no network. Fully deterministic in the dates it
 * produces for a given input, so the pipeline's output is reproducible and
 * testable.
 */

import { daysBetween } from './config'

/** The five persisted horizons. */
export const PLAN_HORIZONS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const
export type PlanHorizon = (typeof PLAN_HORIZONS)[number]

/** One row destined for the `plan_items` table (id-less; ids are DB-side). */
export interface PlanItemRow {
  horizon: PlanHorizon
  phase: string
  title: string
  note: string
  start_date: string | null
  end_date: string | null
  due_date: string | null
  weekly_hours: number | null
}

/** A dated phase span (the quarterly grain of the lattice). */
export interface PhaseSpan {
  name: string
  objective: string
  start_date: string
  end_date: string
}

export interface PhaseInput {
  name: string
  objective: string
}

export interface SchedulerInput {
  today: string
  goal_title: string
  start_date: string
  target_date: string
  weekly_hours: number | null
  /** Phase name → objective (from `goal.phase_objectives`), in order. */
  phases: PhaseInput[]
  /** Milestone semantics, in the order the model emitted them. */
  milestones: Array<{ title: string; phase: string; rationale?: string }>
}

export interface ScheduledMilestone {
  title: string
  phase: string
  rationale?: string
  target_date: string
}

export interface SchedulerResult {
  /** Dated phase spans (ordered). */
  spans: PhaseSpan[]
  /** Milestones with scheduler-assigned dates, in input order. */
  milestones: ScheduledMilestone[]
  /** All rows for `plan_items` (yearly → quarterly → monthly → weekly → daily). */
  items: PlanItemRow[]
}

/** Each horizon keeps this share of its span as unallocated tail buffer. */
export const BUFFER_RATIO = 0.2

/** Whole days in a calendar-friendly rounded way (UTC). */
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime())) return iso
  d.setUTCDate(d.getUTCDate() + Math.round(days))
  return d.toISOString().slice(0, 10)
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The effective window of a span = its first (1 - BUFFER_RATIO). */
export function effectiveWindow(startIso: string, endIso: string): string {
  const total = daysBetween(startIso, endIso)
  return addDaysIso(startIso, total * (1 - BUFFER_RATIO))
}

/** True when `itemIso + slackDays` still lands before `windowEndIso`. */
function landsInside(itemIso: string, windowEndIso: string): boolean {
  return itemIso <= windowEndIso
}

/**
 * Build the multi-horizon lattice for a single plan.
 *
 * Guarantees:
 *   - phase spans are contiguous and partition [start_date, target_date];
 *   - every milestone lands inside its phase's effective (80%) window —
 *     i.e. at or before `start + 0.8 × span`, which is the 20% buffer;
 *   - weekly checkpoints cover exactly the effective window of each phase
 *     (the 20% tail has no work scheduled);
 *   - daily rows mirror the plan's commitments.
 */
export function buildLattice(input: SchedulerInput): SchedulerResult {
  const { phases, milestones } = input
  let start = input.start_date
  let end = input.target_date

  // Defensive normalization — a broken goal span must never produce a
  // confusing empty/garbled lattice.
  let total = daysBetween(start, end)
  if (total < 7) {
    end = addDaysIso(start, 7)
    total = 7
  }

  const n = phases.length
  const spans: PhaseSpan[] =
    n > 0
      ? phases.map((p, i) => {
          const s = i === 0 ? start : addDaysIso(start, Math.round((i * total) / n))
          const e = i === n - 1 ? end : addDaysIso(start, Math.round(((i + 1) * total) / n))
          return {
            name: p.name,
            objective: p.objective,
            start_date: s,
            end_date: e,
          }
        })
      : [{ name: '', objective: '', start_date: start, end_date: end }]

  // Group milestones by phase (preserving their relative order).
  const byPhase = new Map<string, Array<{ title: string; phase: string; rationale?: string }>>()
  for (const m of milestones) {
    const list = byPhase.get(m.phase) ?? []
    list.push(m)
    byPhase.set(m.phase, list)
  }

  // Emit scheduler dates for milestones, in input order (zip by title/order).
  const scheduledByTitle = new Map<string, ScheduledMilestone>()
  const items: PlanItemRow[] = []
  // Continuous week number across the whole plan (Week 1..N) — phases do NOT
  // restart it, so the 3-month view reads "Week 1 … Week 12", not 1,2,3 ×4.
  let weekCounter = 1

  for (const span of spans) {
    const winEnd = effectiveWindow(span.start_date, span.end_date)
    const phaseMilestones = byPhase.get(span.name) ?? []

    // Monthly — milestones spread across the phase's effective window. Each
    // milestone also gets a WORK WINDOW whose start overlaps the previous
    // milestone's, so multiple milestones progress in PARALLEL (the founder's
    // "start prepping system design while applying" case) instead of strictly
    // one-after-another.
    const k = phaseMilestones.length
    const windows: Array<{
      title: string
      phase: string
      rationale?: string
      target: string
      workStart: string
    }> = []
    if (k > 0) {
      const winDays = daysBetween(span.start_date, winEnd)
      const seg = winDays / k
      phaseMilestones.forEach((m, j) => {
        const targetRaw = addDaysIso(span.start_date, Math.round((j + 1) * seg))
        const safeTarget = landsInside(targetRaw, span.end_date) ? targetRaw : winEnd
        // Overlap: milestone j starts at half of its own segment (j=0 → span
        // start), so it runs alongside the previous milestone's tail.
        const workStart = addDaysIso(span.start_date, Math.round(j * seg * 0.5))
        scheduledByTitle.set(m.title, {
          title: m.title,
          phase: m.phase,
          rationale: m.rationale,
          target_date: safeTarget,
        })
        windows.push({ title: m.title, phase: m.phase, rationale: m.rationale, target: safeTarget, workStart })
        items.push({
          horizon: 'monthly',
          phase: m.phase,
          title: m.title,
          note: m.rationale ?? '',
          start_date: workStart,
          end_date: null,
          due_date: safeTarget,
          weekly_hours: null,
        })
      })
    }

    // Weekly — one row per ACTIVE milestone window per 7-day band, so a week
    // can carry parallel workstreams. Each row is labelled with its part
    // number within the milestone's window ("part 1/2"), so consecutive weeks
    // read distinctly instead of repeating the milestone name.
    const weeksInWindow = (startIso: string, endIso: string) =>
      Math.max(1, Math.floor(daysBetween(startIso, endIso) / 7) + 1)

    let w = span.start_date
    while (w < winEnd) {
      const we = addDaysIso(w, 6)
      const bandEnd = we < winEnd ? we : winEnd
      const active = windows.filter((win) => win.workStart <= bandEnd && win.target >= w)
      const labels: Array<{ title: string; note?: string }> =
        active.length > 0
          ? active.map((win) => {
              const total = weeksInWindow(win.workStart, win.target)
              const idx = Math.min(
                total,
                Math.max(1, Math.floor(daysBetween(win.workStart, w) / 7) + 1),
              )
              return { title: `${win.title} — part ${idx}/${total}`, note: win.rationale }
            })
          : [{ title: span.name || 'plan', note: span.objective }]

      // Weekly checkpoints — one per active workstream this week.
      for (const label of labels) {
        items.push({
          horizon: 'weekly',
          phase: span.name,
          title: `Week ${weekCounter} — ${label.title}`,
          note: label.note ?? span.objective,
          start_date: w,
          end_date: bandEnd,
          due_date: null,
          weekly_hours: input.weekly_hours,
        })
      }

      // Per-day tasks — one for EVERY calendar day in the band (weekend
      // included), one row per active workstream. The week's budget is split
      // across the days AND the parallel workstreams.
      const daysInBand = daysBetween(w, bandEnd) + 1
      const perDay =
        input.weekly_hours != null && daysInBand > 0 && labels.length > 0
          ? Math.round((input.weekly_hours / daysInBand / labels.length) * 10) / 10
          : null
      for (const label of labels) {
        for (let d = 0; d < daysInBand; d++) {
          const day = addDaysIso(w, d)
          items.push({
            horizon: 'daily',
            phase: span.name,
            title: label.title,
            note: perDay != null ? `Fulfils “${label.title}” · ${perDay}h` : `Fulfils “${label.title}”`,
            start_date: day,
            end_date: day,
            due_date: day,
            weekly_hours: null,
          })
        }
      }

      w = addDaysIso(bandEnd, 1)
      weekCounter += 1
    }
  }

  // Quarterly — one row per phase span.
  for (const span of spans) {
    if (!span.name) continue
    items.push({
      horizon: 'quarterly',
      phase: span.name,
      title: span.name,
      note: span.objective,
      start_date: span.start_date,
      end_date: span.end_date,
      due_date: null,
      weekly_hours: input.weekly_hours,
    })
  }

  // Yearly — the goal span itself.
  items.unshift({
    horizon: 'yearly',
    phase: '',
    title: input.goal_title,
    note: `${n} phases, 20% per-horizon buffer`,
    start_date: start,
    end_date: end,
    due_date: null,
    weekly_hours: input.weekly_hours,
  })

  const milestonesOut = milestones.map(
    (m) =>
      scheduledByTitle.get(m.title) ?? {
        title: m.title,
        phase: m.phase,
        rationale: m.rationale,
        target_date: start, // last-resort: never emit a broken plan
      },
  )

  return { spans, milestones: milestonesOut, items }
}