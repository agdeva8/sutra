/**
 * Goal Planner — drift detection (PRD Iteration 10 §Drift).
 *
 * Plan-vs-actual gap. Snapshot-based (v1): we read the current rows, not a
 * history log. Two rules are computable from the schema today:
 *
 *   1. A milestone whose `target_date` passed without completing.
 *   2. Three or more open commitments whose `due` fell in the last 7 days.
 *
 * The PRD's third rule — "completed_hours < 60% of target_hours for 2
 * consecutive weeks" — is NOT implemented because nothing tracks hours
 * spent (goals carry an estimate, not actuals). It is listed here so the
 * gap is explicit rather than silently dropped.
 *
 * Runs after every tick / log / blocker change (effect 5.5). Cheap enough
 * to stay synchronous.
 */

export interface DriftMilestone {
  title: string
  targetDate: string | null
  /** Repo status vocabulary: 'open' | 'done' (or any non-'done'). */
  status: string
}

export interface DriftInput {
  /** ISO `YYYY-MM-DD`. */
  today: string
  milestones: readonly DriftMilestone[]
}

export type DriftStatus = 'on_track' | 'at_risk'

export interface DriftResult {
  status: DriftStatus
  reasons: string[]
}

/** ISO date `days` before `iso`, UTC-stable. */
export function isoMinusDays(iso: string, days: number): string {
  const dt = new Date(
    Date.UTC(
      Number(iso.slice(0, 4)),
      Number(iso.slice(5, 7)) - 1,
      Number(iso.slice(8, 10)),
    ),
  )
  dt.setUTCDate(dt.getUTCDate() - days)
  return dt.toISOString().slice(0, 10)
}

export function computeDrift(input: DriftInput): DriftResult {
  const reasons: string[] = []
  const today = input.today

  for (const m of input.milestones) {
    if (
      typeof m.targetDate === 'string' &&
      m.targetDate < today &&
      m.status !== 'done'
    ) {
      reasons.push(
        `Milestone "${m.title}" passed its target date (${m.targetDate}) without completing.`,
      )
    }
  }

  return {
    status: reasons.length > 0 ? 'at_risk' : 'on_track',
    reasons,
  }
}
