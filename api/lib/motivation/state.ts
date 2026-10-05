/**
 * Motivation agent — state extraction.
 *
 * `extractLackingSignals` reads a tiny slice of the user's state
 * (overdue commitments, active goals, last-activity timestamp) and
 * distills it into the `LackingSignals` shape used by:
 *
 *   - `recommend.ts` to build Tavily search queries and the cache key.
 *   - `frame.ts` to inject the right state sentence into the LLM frame.
 *
 * `computeStateHash` produces a stable hex digest of the signals so
 * `motivation_cache` can key on (user, bucket, hash) and re-serve the
 * same recommendations for the same input state without re-running
 * the pipeline.
 *
 * The slice is deliberately small — three queries max — so this stays
 * cheap enough to run on every MotivationCard mount.
 */

import 'server-only'

import { createHash } from 'node:crypto'

import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { goals, milestones } from '@/db/schema'

import type { Bucket, LackingSignals } from './schema'

/* -------------------------------------------------------------------------- */
/* extractLackingSignals                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pull the bits of user state that influence search queries and the
 * frame. Single round-trip via parallel queries — the three queries
 * below are independent and fire together.
 *
 * Theme bag heuristics (intentionally lightweight at MVP):
 *   - overdue → goal titles of the overdue commitments, deduped.
 *   - dormant → active goal titles.
 *   - stuck   → active goal titles (same as dormant — the LLM gets
 *                a stronger state sentence to disambiguate).
 */
export async function extractLackingSignals(args: {
  userId: string
  bucket: Bucket
}): Promise<LackingSignals> {
  const { userId, bucket } = args
  const today = new Date().toISOString().slice(0, 10)

  // Always pull active goals for the theme bag.
  const activeGoals = await db
    .select({ id: goals.id, title: goals.title })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, 'active')))
    .limit(50)

  // For overdue: also pull overdue milestone titles + count + slippage.
  let overdueRows: { id: string; goalTitle: string; due: string | null }[] = []
  if (bucket === 'overdue') {
    overdueRows = await db
      .select({
        id: milestones.id,
        goalTitle: milestones.goalTitle,
        due: milestones.targetDate,
      })
      .from(milestones)
      .where(
        and(
          eq(milestones.userId, userId),
          isNotNull(milestones.targetDate),
          lt(milestones.targetDate, today),
        ),
      )
      .limit(50)
  }

  // days_since_last_activity = max(updatedAt) over active goals.
  let lastActivity: Date | null = null
  const lastRow = await db
    .select({ updatedAt: goals.updatedAt })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, 'active')))
    .orderBy(sql`${goals.updatedAt} desc`)
    .limit(1)
  if (lastRow[0]?.updatedAt) lastActivity = lastRow[0].updatedAt

  const themes = buildThemeBag({ bucket, activeGoals, overdueRows })

  const out: LackingSignals = {
    bucket,
    themes,
    days_since_last_activity: daysBetween(lastActivity, new Date()),
  }

  if (bucket === 'overdue') {
    out.overdue_count = overdueRows.length
    out.avg_slippage_days = averageSlippageDays(overdueRows, today)
  }

  return out
}

/* -------------------------------------------------------------------------- */
/* computeStateHash                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Stable hash of the inputs that drive recommendations. Same input
 * must produce the same hash so cache reads return the same items.
 *
 * Hash inputs: bucket, sorted themes, overdue_count, avg_slippage_days,
 * and a coarse-grained last-activity day (so small clock drift does
 * not invalidate the cache).
 */
export function computeStateHash(signals: LackingSignals): string {
  const themesKey = [...signals.themes].sort().join('|')
  const lastDay = signals.days_since_last_activity
    ? Math.floor(signals.days_since_last_activity / 1) // day granularity
    : 'na'
  const overdueKey = signals.overdue_count ?? 'na'
  const slipKey =
    typeof signals.avg_slippage_days === 'number'
      ? signals.avg_slippage_days.toFixed(1)
      : 'na'
  const payload =
    `${signals.bucket}::${themesKey}::${overdueKey}::${slipKey}::${lastDay}`
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function buildThemeBag(args: {
  bucket: Bucket
  activeGoals: { title: string }[]
  overdueRows: { goalTitle: string }[]
}): string[] {
  const sources =
    args.bucket === 'overdue' && args.overdueRows.length > 0
      ? args.overdueRows.map((r) => r.goalTitle)
      : args.activeGoals.map((g) => g.title)

  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of sources) {
    const t = cleanTheme(raw)
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= 8) break
  }
  return out
}

function cleanTheme(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 60)
}

function daysBetween(later: Date | null, earlier: Date): number {
  if (!later) return 0
  const ms = earlier.getTime() - later.getTime()
  if (ms < 0) return 0
  return Math.floor(ms / 86400000)
}

function averageSlippageDays(
  rows: { due: string | null }[],
  todayIso: string,
): number {
  if (rows.length === 0) return 0
  const today = new Date(`${todayIso}T00:00:00Z`).getTime()
  let total = 0
  let count = 0
  for (const r of rows) {
    if (!r.due) continue
    const due = new Date(`${r.due}T00:00:00Z`).getTime()
    const slip = Math.max(0, today - due)
    total += slip
    count += 1
  }
  if (count === 0) return 0
  return total / count / 86400000
}
