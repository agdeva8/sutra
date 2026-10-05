/**
 * Over-commitment heuristic — load-level chip.
 *
 * Source of truth: backend/server.py:223-240 (the `load_state` body
 * that derives `over_commitment` from the active goal and open
 * commitment counts).
 *
 * This module is the single owner of the heuristic so both:
 *   - `lib/llm/state-builder.ts` (the chat-time context string)
 *   - `app/api/state/route.ts` (the dashboard JSON)
 *   - `components/coach/TrackingDashboard.tsx` (the dashboard chip UI)
 * render the same level / message / chip color. If we ever tweak the
 * thresholds, every consumer stays in sync.
 *
 * Rules (mirrored from server.py, DO NOT EDIT WITHOUT UPDATING THE LEGACY
 * BACKEND TOO):
 *
 *   active_goals >= 7  → critical   "… is a wish-list, not a week. …"
 *   active_goals >= 5  → high       "… and N promises in flight — …"
 *   open_commits > 4   → high       "N open promises across M goals — …"
 *   active_goals >= 3  → moderate   "N goals in play. Doable, but only one can lead this week."
 *   otherwise          → clear      "A steady, focused load."
 *
 * `conflicting` (returned only at critical / high-goals levels) is the
 * titles of up to 3 active goals, so the UI can render a "pause one of
 * these" callout.
 */

export type OverCommitmentLevel = 'clear' | 'moderate' | 'high' | 'critical'

export interface OverCommitmentGoal {
  id?: string
  title: string
  status: 'active' | 'paused' | 'dropped'
}

export interface OverCommitment {
  level: OverCommitmentLevel
  message: string
  conflicting: string[]
  active_goals: number
  open_commitments: number
}

/**
 * Pure function — no DB calls. Given the user's active goals and all
 * commitments (any status), derive the chip.
 *
 * Both arrays are accepted as already-loaded arrays so this stays
 * trivially testable in isolation. `loadState()` in state-builder.ts
 * hands us the same shape.
 */
export function computeOverCommitment(
  goalsList: OverCommitmentGoal[],
): OverCommitment {
  const active = goalsList.filter((g) => g.status === 'active')

  let level: OverCommitmentLevel = 'clear'
  let message = 'A steady, focused load.'
  const conflicting: string[] = []
  const n = active.length

  if (n >= 7) {
    level = 'critical'
    message = `${n} goals at once is a wish-list, not a week. Something needs to be paused.`
    conflicting.push(...active.slice(0, 3).map((g) => g.title))
  } else if (n >= 5) {
    level = 'high'
    message = `${n} goals in flight — your attention is stretched thin.`
    conflicting.push(...active.slice(0, 3).map((g) => g.title))
  } else if (n >= 3) {
    level = 'moderate'
    message = `${n} goals in play. Doable, but only one can lead this week.`
  }

  return {
    level,
    message,
    conflicting,
    active_goals: n,
    open_commitments: 0,
  }
}

/**
 * Tailwind color tokens for each level. Single source of truth so the
 * dashboard chip + the "strained" callout share the same palette.
 */
export function levelColor(level: OverCommitmentLevel): {
  bg: string
  text: string
  border: string
  dot: string
} {
  switch (level) {
    case 'clear':
      return {
        bg: 'bg-green-50 dark:bg-green-950/30',
        text: 'text-green-700 dark:text-green-300',
        border: 'border-green-200 dark:border-green-800',
        dot: 'bg-green-500',
      }
    case 'moderate':
      return {
        bg: 'bg-amber-50 dark:bg-amber-950/30',
        text: 'text-amber-700 dark:text-amber-300',
        border: 'border-amber-200 dark:border-amber-800',
        dot: 'bg-amber-500',
      }
    case 'high':
      return {
        bg: 'bg-orange-50 dark:bg-orange-950/30',
        text: 'text-orange-700 dark:text-orange-300',
        border: 'border-orange-200 dark:border-orange-800',
        dot: 'bg-orange-500',
      }
    case 'critical':
      return {
        bg: 'bg-red-50 dark:bg-red-950/30',
        text: 'text-red-700 dark:text-red-300',
        border: 'border-red-200 dark:border-red-800',
        dot: 'bg-red-500',
      }
  }
}
