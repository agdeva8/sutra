/**
 * Motivation agent — picker.
 *
 * Applies the three deterministic gates from `config.ts` to scored
 * candidates, enforces diversity (≤ 1 pass per hostname), writes
 * rejected candidates to `motivation_rejects` for tuning, and returns
 * the top N picks.
 *
 * Gates (mirrors lib/motivation/config.ts):
 *   1. core_four       — credibility, recency, depth, actionability
 *                        must EACH individually clear 0.6
 *   2. k_of_n          — at least 5 of 10 params must individually > 0.6
 *   3. weighted_total  — weighted sum × 10 must be ≥ 6.5
 *
 * Diversity rule (per founder decision, Iteration 6 plan): ≤ 1 pass
 * per hostname. Books/videos/articles can still mix.
 *
 * If we still have < n passes after diversity enforcement, we return
 * however many we have. The caller (`recommend.ts`) turns an empty pick
 * into the "searching" response; there is no catalogue fallback.
 */

import 'server-only'

import { createHash } from 'node:crypto'

import { db } from '@/lib/db'
import { motivationRejects } from '@/db/schema'

import {
  K_OF_N_MIN,
  WEIGHTED_TOTAL_FLOOR,
  countAboveFloor,
  passesCoreFour,
} from './config'
import {
  type Bucket,
  type RejectLogEntry,
  type ScoredCandidate,
} from './schema'

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface PickResult {
  picks: ScoredCandidate[]
  rejected: RejectLogEntry[]
}

/**
 * Pick up to `n` survivors from `scoredCandidates`. Sorted by
 * `weighted_total` desc before gating; ties broken by URL hash so
 * order is deterministic across runs.
 *
 * Caller is responsible for forwarding `rejected` to a persist step
 * if persistence is desired — `pickTopN` itself only builds the log
 * entries; it does not write them. The orchestrator writes them in
 * a single batch so a partial failure does not leave half the log.
 */
export function pickTopN(args: {
  scored: ScoredCandidate[]
  n: number
  bucket: Bucket
}): PickResult {
  const { scored, n, bucket } = args

  // Deterministic ordering: weighted_total desc, then url asc.
  const sorted = [...scored].sort((a, b) => {
    if (b.weighted_total !== a.weighted_total) {
      return b.weighted_total - a.weighted_total
    }
    return a.url.localeCompare(b.url)
  })

  const passes: ScoredCandidate[] = []
  const rejected: RejectLogEntry[] = []
  const seenDomains = new Set<string>()

  for (const c of sorted) {
    const gatesFailed: RejectLogEntry['gates_failed'] = []
    if (!passesCoreFour(c.scores)) gatesFailed.push('core_four')
    if (countAboveFloor(c.scores) < K_OF_N_MIN) gatesFailed.push('k_of_n')
    if (c.weighted_total < WEIGHTED_TOTAL_FLOOR) {
      gatesFailed.push('weighted_total')
    }

    if (gatesFailed.length > 0) {
      rejected.push({
        url: c.url,
        bucket,
        score_breakdown: c.scores,
        weighted_total: c.weighted_total,
        top_reasons: c.top_reasons.slice(0, 3),
        gates_failed: gatesFailed,
      })
      continue
    }

    // Diversity: ≤ 1 pass per hostname.
    const domain = safeDomain(c.url)
    if (seenDomains.has(domain)) {
      // Treat diversity-rejected candidates as k_of_n-equivalent for
      // the log so we can see in the reject table when the diversity
      // rule was the bottleneck.
      rejected.push({
        url: c.url,
        bucket,
        score_breakdown: c.scores,
        weighted_total: c.weighted_total,
        top_reasons: c.top_reasons.slice(0, 3),
        gates_failed: ['k_of_n'],
      })
      continue
    }

    seenDomains.add(domain)
    passes.push(c)
    if (passes.length >= n) break
  }

  return { picks: passes, rejected }
}

/* -------------------------------------------------------------------------- */
/* Reject-log persistence                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Persist a batch of reject-log entries for tuning. Best-effort —
 * errors are swallowed (logged to stderr) so a DB hiccup never
 * fails the user's request.
 */
export async function persistRejects(
  userId: string,
  bucket: Bucket,
  rejected: RejectLogEntry[],
): Promise<void> {
  if (rejected.length === 0) return
  try {
    await db.insert(motivationRejects).values(
      rejected.map((r) => ({
        id: makeRejectId(userId, r.url),
        userId,
        bucket,
        url: r.url,
        // We don't carry title through the picker; a follow-up schema
        // bump can store it if the tuning UI needs it.
        title: '',
        scoreBreakdown: r.score_breakdown,
        weightedTotal: r.weighted_total,
        topReasons: r.top_reasons,
        gatesFailed: r.gates_failed,
      })),
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[motivation] failed to persist rejects:', err)
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return url
  }
}

function makeRejectId(userId: string, url: string): string {
  const h = createHash('sha256').update(`${userId}::${url}`).digest('hex')
  return `rej_${h.slice(0, 24)}`
}
