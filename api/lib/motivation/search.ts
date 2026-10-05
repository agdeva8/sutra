/**
 * Motivation agent — Tavily search stage.
 *
 * POST https://api.tavily.com/search with an array of query strings.
 * Returns the union of raw results, deduped by URL, scored by Tavily.
 *
 * Why direct HTTP and not the Tavily JS SDK:
 *   - One fewer dep. The wire shape is stable and tiny.
 *   - Tavily's auth convention is `api_key` in the body (not Bearer)
 *     so the SDK mostly wraps a single POST — not much to gain.
 *
 * Failure modes:
 *   - 401/403 / missing key  → return [] (caller returns empty "searching")
 *   - 429 rate limit         → return whatever we got, log + bail
 *   - Network error / timeout → return [] (caller falls back)
 *   - Per-query failure      → other queries still contribute
 *
 * Stage timeout: STAGE_TIMEOUTS.search (4s). We race the whole batch
 * with `Promise.race` against a timeout promise so a slow network
 * doesn't blow the pipeline budget.
 */

import 'server-only'

import { TAVILY_API_KEY, MAX_SEARCH_QUERIES, STAGE_TIMEOUTS } from './config'

/* -------------------------------------------------------------------------- */
/* Wire types — mirror Tavily's response shape                                */
/* -------------------------------------------------------------------------- */

export interface TavilyRawResult {
  url: string
  title: string
  /** Snippet (~300 chars) — what we use for the card excerpt if no body fetch. */
  content: string
  /** Tavily's own relevance score, 0-1. */
  score: number
  /** Optional — only set if `include_raw_content: true` (we don't use). */
  raw_content?: string
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run a batch of Tavily searches and return the merged, deduped result set.
 *
 * Caller (recommend.ts) supplies queries already capped at
 * MAX_SEARCH_QUERIES; we re-cap defensively in case a future caller
 * forgets. The stage timeout fires regardless of how many queries
 * are in flight.
 */
export async function searchTavily(args: {
  queries: string[]
  signal?: AbortSignal
}): Promise<TavilyRawResult[]> {
  const { queries, signal } = args
  if (!TAVILY_API_KEY) {
    return []
  }
  const capped = queries.slice(0, MAX_SEARCH_QUERIES)
  if (capped.length === 0) return []

  const deadline = makeDeadline(STAGE_TIMEOUTS.search, signal)

  // Race each query + the deadline. Use allSettled so one query failure
  // doesn't drop the rest; the deadline short-circuits all of them at once.
  const settled = await Promise.allSettled(
    capped.map((q) => runOne(q, deadline.signal)),
  )

  const merged: TavilyRawResult[] = []
  const seen = new Set<string>()
  for (const r of settled) {
    if (r.status !== 'rejected') {
      for (const hit of r.value) {
        if (!seen.has(hit.url)) {
          seen.add(hit.url)
          merged.push(hit)
        }
      }
    }
  }
  return merged
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

async function runOne(
  query: string,
  signal: AbortSignal,
): Promise<TavilyRawResult[]> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Tavily wants the key in the body — not as Bearer.
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      max_results: 10,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
    signal,
    cache: 'no-store',
  })

  if (!resp.ok) {
    // Caller catches and treats as empty. We re-throw so the per-query
    // rejection is visible in logs without masking the other queries.
    throw new Error(`tavily_${resp.status}`)
  }

  const data = (await resp.json()) as { results?: TavilyRawResult[] }
  return Array.isArray(data.results) ? data.results : []
}

function makeDeadline(
  ms: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  // If the parent signal aborts, forward it.
  const onParent = () => ctrl.abort()
  parent?.addEventListener('abort', onParent, { once: true })
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParent)
      ctrl.abort()
    },
  }
}
