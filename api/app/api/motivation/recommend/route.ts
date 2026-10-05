/**
 * GET /api/motivation/recommend
 *
 * Returns 1-3 motivation items for the current user. Delegates to
 * `recommend()` in `api/lib/motivation/recommend.ts` which runs the
 * full search → fetch → critique → picker → frame pipeline with a
 * 24h cache. On a cold miss the route returns an empty items list (the
 * card renders a "searching" line) and the pipeline runs in the
 * background; `maxDuration` bounds the request.
 *
 * The card-side contract is `{ bucket, items, generated_at, cache }`.
 * `MotivationCard` polls every 5s while `cache` is `'miss'` / `'stale'`
 * (a background refresh is in flight) and gives up after 60s.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { and, eq, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { goals, milestones } from '@/db/schema'
import { resolveRequestUser } from '@/lib/request-user'

import {
  type Bucket,
  computeStateHash,
  extractLackingSignals,
  recommend,
} from '@/lib/motivation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/**
 * Cold-miss calls block on the pipeline (up to ~25s typical, 35s
 *  timeout). Bound the route at 60s to leave headroom for retries and
 *  cold-start latency. Vercel's default is 10s on Hobby, 60s on Pro
 *  for Node runtimes — pinning this explicitly so production doesn't
 *  silently truncate the request.
 */
export const maxDuration = 60

/**
 * Dev-only remap: bearer auth (`Authorization: Bearer dev_*`) creates
 * a synthetic userId that does NOT exist in the `users` table, which
 * makes any FK-protected write (motivation_cache, motivation_rejects,
 * motivation_served_log) fail. In production this branch is dead code
 * — `caller.source === 'bearer'` is gated on `ALLOW_DEV_LOGIN` /
 * `NODE_ENV === 'test'`, both of which must be off in prod.
 *
 * Remap any bearer-sourced caller to the founder id so persistence
 * layers exercise end-to-end during dev. The card-side cache and
 * reject log will be polluted across dev users; that's acceptable —
 * they're dev-only.
 */
const FOUNDER_ID = 'user_founder01'

function resolvePersistableUserId(
  caller: { userId: string; source: 'session' | 'guest' | 'bearer' },
): string {
  if (caller.source === 'bearer') return FOUNDER_ID
  return caller.userId
}

/* -------------------------------------------------------------------------- */
/* Bucket detection — same logic the v0 route used, kept verbatim so the     */
/* front-end's "Picked from what you're working on" promise still holds.     */
/* -------------------------------------------------------------------------- */

async function detectBucket(userId: string): Promise<Bucket> {
  const today = new Date().toISOString().slice(0, 10)

  const overdue = await db
    .select({ id: milestones.id })
    .from(milestones)
    .where(and(eq(milestones.userId, userId), lt(milestones.targetDate, today)))
    .limit(50)
  if (overdue.length > 0) return 'overdue'

  const activeGoals = await db
    .select({ id: goals.id, updatedAt: goals.updatedAt })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, 'active')))
    .limit(50)
  if (activeGoals.length === 0) return 'stuck'

  // Dormant = has active goals but no goal activity for 21+ days.
  // Anchored on goals.updatedAt (ticks on every commitment / milestone
  // write that touches the goal).
  const dormantCutoff = new Date(Date.now() - 21 * 86400000)
  const hasActiveRecent = activeGoals.some(
    (g) => g.updatedAt && g.updatedAt >= dormantCutoff,
  )
  if (!hasActiveRecent) return 'dormant'

  return 'stuck'
}

/* -------------------------------------------------------------------------- */
/* GET                                                                        */
/* -------------------------------------------------------------------------- */

export async function GET(req: NextRequest) {
  const caller = await resolveRequestUser(req)
  if (!caller) {
    return NextResponse.json({ detail: 'Not authenticated' }, { status: 401 })
  }
  const userId = resolvePersistableUserId(caller)

  const url = new URL(req.url)
  const count = Math.min(3, Math.max(1, Number(url.searchParams.get('n')) || 3))

  let bucket: Bucket = 'stuck'
  try {
    bucket = await detectBucket(userId)
  } catch {
    bucket = 'stuck'
  }

  // Extract lacking signals and compute the cache key. The signal
  // extract is best-effort — a DB hiccup shouldn't take down the
  // recommendation; we fall through to the orchestrator with whatever
  // we have, which returns the empty "searching" response on failure.
  const signals = await extractLackingSignals({ userId, bucket }).catch(
    () => ({ bucket, themes: [] }),
  )
  const stateHash = computeStateHash(signals)

  // Never blocks on the pipeline: a miss returns empty immediately and
  // the pipeline runs in the background (see recommend.ts). The route's
  // `maxDuration = 60` bounds the request at the platform layer.
  const response = await recommend({
    userId,
    bucket,
    stateHash,
    n: count,
  })
  return NextResponse.json(response)
}
