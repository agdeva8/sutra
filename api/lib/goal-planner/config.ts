/**
 * Goal Planner — runtime config (flag + bounds + horizon windows).
 *
 * Iteration 10. Mirrors the shape of `lib/motivation/config.ts` (the model
 * the PRD points at): one file owns every tunable so the orchestrator and the
 * pure modules never hard-code a threshold.
 *
 * The flag reads `process.env` directly rather than importing `lib/env.ts`, so
 * this module stays importable from unit tests without a boot-validated
 * environment — same rationale as motivation/config.ts, minus the env import.
 */

import 'server-only'

/* -------------------------------------------------------------------------- */
/* Feature flag                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Master switch. ON by default (Iteration 10 flipped on after founder
 * testing); set `GOAL_PLANNER_ENABLED=false` to fall back to the legacy
 * one-shot chat path. When false the orchestrator is never called and the
 * legacy one-shot chat path acts.
 */
/**
 * parsing — default ON. The planner is now the primary path for the five
 * planned kinds; unsetting the env var falls back to the legacy chat path
 * only when explicitly set to 'false'.
 */
function parseEnabledFlag(raw: string | undefined): boolean {
  if (raw === 'false') return false
  return true
}

export const GOAL_PLANNER_ENABLED = parseEnabledFlag(
  process.env.GOAL_PLANNER_ENABLED,
)

/**
 * Optional comma-separated user-id allowlist for dogfood (rollout step 3).
 * Empty = the flag applies to everyone once enabled.
 */
export const GOAL_PLANNER_USER_ALLOWLIST: readonly string[] = (
  process.env.GOAL_PLANNER_USER_ALLOWLIST ?? ''
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** True when the plan pipeline should handle `userId`'s planned intents. */
export function isGoalPlannerEnabledFor(userId?: string | null): boolean {
  if (!GOAL_PLANNER_ENABLED) return false
  if (GOAL_PLANNER_USER_ALLOWLIST.length === 0) return true
  return !!userId && GOAL_PLANNER_USER_ALLOWLIST.includes(userId)
}

/* -------------------------------------------------------------------------- */
/* Pipeline bounds                                                            */
/* -------------------------------------------------------------------------- */

/** Max renegotiation rounds before falling back to `no_change`. */
export const MAX_RENEGOTIATION_ROUNDS = 2

/**
 * Headroom slack: when the plan overshoots the budget by up to this many hours
 * we proceed and let the prose name the tightness; beyond it we renegotiate.
 * (PRD Stage 3.5: `free >= -5h` → proceed.)
 */
export const CAP_TIGHT_SLACK_HOURS = 5

/** `goals.weekly_hours` bounds (PRD schema note: "1-20"). */
export const MIN_WEEKLY_HOURS = 1
export const MAX_WEEKLY_HOURS = 20

/** Plan shape bounds. */
export const MIN_PHASES = 2
export const MAX_PHASES = 4
export const MIN_MILESTONES = 3
export const MAX_MILESTONES = 8
export const MAX_BLOCKERS = 3
export const MIN_COMMITMENTS = 1
export const MAX_COMMITMENTS = 3
export const MAX_PLAN_BLOCKS = 8
export const MAX_TOOLS = 16
export const MAX_CLARIFYING_QUESTIONS = 6

/* -------------------------------------------------------------------------- */
/* Horizon windows                                                            */
/* -------------------------------------------------------------------------- */

export const HORIZONS = ['weekly', 'short', 'medium', 'long'] as const
export type Horizon = (typeof HORIZONS)[number]

/** Inclusive [minDays, maxDays] from today, per PRD §Glossary. */
export const HORIZON_WINDOWS: Record<Horizon, readonly [number, number]> = {
  weekly: [7, 14],
  short: [30, 90],
  medium: [90, 270],
  long: [270, 540],
}

export function horizonWindow(horizon: Horizon): {
  minDays: number
  maxDays: number
} {
  const [minDays, maxDays] = HORIZON_WINDOWS[horizon]
  return { minDays, maxDays }
}

/** Whole days between two ISO `YYYY-MM-DD` dates (b - a), UTC, no TZ drift. */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.UTC(
    Number(aIso.slice(0, 4)),
    Number(aIso.slice(5, 7)) - 1,
    Number(aIso.slice(8, 10)),
  )
  const b = Date.UTC(
    Number(bIso.slice(0, 4)),
    Number(bIso.slice(5, 7)) - 1,
    Number(bIso.slice(8, 10)),
  )
  return Math.round((b - a) / 86_400_000)
}

/** True when `targetIso` falls inside the horizon's window from `todayIso`. */
export function isDateInHorizon(
  targetIso: string,
  horizon: Horizon,
  todayIso: string,
): boolean {
  const { minDays, maxDays } = horizonWindow(horizon)
  const d = daysBetween(todayIso, targetIso)
  return d >= minDays && d <= maxDays
}
