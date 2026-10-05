/**
 * SWR miss-path tests for the orchestrator.
 *
 * Scope: a cheap assertion about `emptyResponse` — the shape the cold-miss
 * path (recommend.ts) returns while the pipeline runs in the background.
 * The full pipeline (DB + Tavily + LLM critiques) is exercised by
 * integration; mocking all of it in a unit test would just be a
 * re-implementation.
 *
 * If the shape drifts, the frontend's SWR poll loop won't start (it reads
 * `d.cache`) and the card would never show its "searching" state, so the
 * cost of an extra test file is worth it.
 */

import { describe, expect, it } from 'vitest'

import { RecommendationResponseSchema } from '../schema'

// `emptyResponse` lives in `recommend.ts` as a module-local helper. It's
// exposed via `_internal` for tests because the SWR cold-miss branch in
// `recommend()` depends on its exact contract shape. Production code should
// never call it directly — go through `recommend()`.
import { _internal as recommendInternal } from '../recommend'
const { emptyResponse } = recommendInternal

describe('recommend — SWR cold-miss shape (emptyResponse)', () => {
  it('returns an empty, valid RecommendationResponse with cache: miss', () => {
    const res = emptyResponse('overdue')
    const parsed = RecommendationResponseSchema.parse(res)
    expect(parsed.cache).toBe('miss')
    expect(parsed.bucket).toBe('overdue')
    expect(parsed.items).toEqual([])
    // ISO date — Zod's refinement already asserts this; the second check
    // makes the test self-documenting about *why* it matters.
    expect(parsed.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('echoes the bucket so the card can keep its per-state framing', () => {
    expect(emptyResponse('stuck').bucket).toBe('stuck')
    expect(emptyResponse('dormant').bucket).toBe('dormant')
  })
})
