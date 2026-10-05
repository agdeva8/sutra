/**
 * Motivation agent — Zod schemas.
 *
 * Single source of truth for the shapes that flow between the
 * Next.js route handler, the pipeline stages (search → fetch →
 * critique → picker → frame), the Postgres cache table, and the
 * existing `MotivationCard` consumer.
 *
 * Why Zod here and not Drizzle's inferred types:
 *   - The pipeline stages cross an LLM boundary (the critique step
 *     emits structured JSON we need to validate before scoring).
 *   - The cache payload is JSONB and we want runtime shape checks
 *     on read, not just on write.
 *   - Drizzle-zod is already a dep so we get identical patterns for
 *     free.
 */

import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Three buckets the user can land in. Mirrors the existing
 * `detectBucket()` logic in api/app/api/motivation/recommend/route.ts.
 */
export const BucketSchema = z.enum(['overdue', 'dormant', 'stuck'])
export type Bucket = z.infer<typeof BucketSchema>

/** Content kind — drives the icon in MotivationCard.js (KindIcon). */
export const KindSchema = z.enum(['video', 'article', 'book', 'talk'])
export type Kind = z.infer<typeof KindSchema>

/** Cache-hit indicator for telemetry / response shape. */
export const CacheStatusSchema = z.enum(['hit', 'miss', 'stale'])
export type CacheStatus = z.infer<typeof CacheStatusSchema>

/* -------------------------------------------------------------------------- */
/* 10 scoring parameters — names + weights + the "core four" gate            */
/* -------------------------------------------------------------------------- */

/**
 * The 10 critique dimensions used by `lib/motivation/critique.ts`.
 * The order here is the canonical order everywhere (picker, prompt,
 * log fields). Don't reorder casually — changing this breaks log
 * parsers and cache rows on read.
 *
 *   core four (must each individually > 0.6):
 *     - credibility (weight 0.15)
 *     - recency     (weight 0.10)
 *     - depth       (weight 0.15)
 *     - actionability (weight 0.15)
 *
 *   supporting six (still scored, must clear k-of-n threshold):
 *     - citation_density     (0.10)
 *     - engagement_volume    (0.08)
 *     - engagement_quality   (0.08)
 *     - voice_fit            (0.08)
 *     - source_independence  (0.06)
 *     - accessibility        (0.05)
 */
export const SCORE_KEYS = [
  'credibility',
  'recency',
  'depth',
  'actionability',
  'citation_density',
  'engagement_volume',
  'engagement_quality',
  'voice_fit',
  'source_independence',
  'accessibility',
] as const

export type ScoreKey = (typeof SCORE_KEYS)[number]

export const SCORE_WEIGHTS: Record<ScoreKey, number> = {
  credibility: 0.15,
  recency: 0.1,
  depth: 0.15,
  actionability: 0.15,
  citation_density: 0.1,
  engagement_volume: 0.08,
  engagement_quality: 0.08,
  voice_fit: 0.08,
  source_independence: 0.06,
  accessibility: 0.05,
}

/** The four "core" params that must each individually > 0.6. */
export const CORE_PARAMS: ReadonlyArray<ScoreKey> = [
  'credibility',
  'recency',
  'depth',
  'actionability',
]

/* -------------------------------------------------------------------------- */
/* Candidate — what the fetcher produces                                     */
/* -------------------------------------------------------------------------- */

export const CandidateSchema = z.object({
  /** Stable id derived from URL hash — survives cache reads. */
  id: z.string().min(1),
  bucket: BucketSchema,
  kind: KindSchema,
  title: z.string().min(1),
  author: z.string().min(1),
  url: z.string().url(),
  duration: z.string().min(1),
  /** Short excerpt (≤ 500 chars) shown in the card. */
  excerpt: z.string().min(1).max(500),
  /** Arbitrary metadata from the search/fetch step. */
  sourceMeta: z.record(z.string(), z.unknown()).default({}),
})
export type Candidate = z.infer<typeof CandidateSchema>

/* -------------------------------------------------------------------------- */
/* ScoredCandidate — what the critique stage produces                        */
/* -------------------------------------------------------------------------- */

/** A 0-1 score. Branded so we can't accidentally pass a percentage. */
const ScoreSchema = z.number().min(0).max(1)

/** Per-parameter score map. Keys are SCORE_KEYS. */
export const ScoreBreakdownSchema = z.object({
  credibility: ScoreSchema,
  recency: ScoreSchema,
  depth: ScoreSchema,
  actionability: ScoreSchema,
  citation_density: ScoreSchema,
  engagement_volume: ScoreSchema,
  engagement_quality: ScoreSchema,
  voice_fit: ScoreSchema,
  source_independence: ScoreSchema,
  accessibility: ScoreSchema,
})
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>

export const CritiqueVerdictSchema = z.enum(['pass', 'reject'])
export type CritiqueVerdict = z.infer<typeof CritiqueVerdictSchema>

export const ScoredCandidateSchema = CandidateSchema.extend({
  scores: ScoreBreakdownSchema,
  /** Weighted sum of scores, 0-10 (each score * weight, summed, * 10). */
  weighted_total: z.number().min(0).max(10),
  verdict: CritiqueVerdictSchema,
  /** Top 1-5 reasons, used in the reject log + per-item "frame". */
  top_reasons: z.array(z.string().min(1)).max(5).default([]),
})
export type ScoredCandidate = z.infer<typeof ScoredCandidateSchema>

/* -------------------------------------------------------------------------- */
/* RecommendationItem — what the picker returns to the route handler          */
/* -------------------------------------------------------------------------- */

/**
 * Final card item — what the existing MotivationCard component
 * already consumes (id, kind, title, author, url, duration, frame).
 * Field names match so the route handler can return this directly
 * without remapping.
 */
export const RecommendationItemSchema = z.object({
  id: z.string().min(1),
  kind: KindSchema,
  title: z.string().min(1),
  author: z.string().min(1),
  url: z.string().url(),
  duration: z.string().min(1),
  /** Server-generated one-line frame ("Right now, you have items past due. …") */
  frame: z.string().min(1),
  /** Original excerpt from the candidate. */
  excerpt: z.string().min(1).max(500),
  /** Echoed for transparency; the card does not render this in MVP. */
  score_total: z.number().min(0).max(10),
})
export type RecommendationItem = z.infer<typeof RecommendationItemSchema>

/* -------------------------------------------------------------------------- */
/* Request / response shapes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the Next.js route handler sends into the pipeline.
 * The route handler already has the bucket from `detectBucket()` and
 * a state_hash from the request's (commitments, goals) snapshot, so
 * the pipeline never queries the DB for user state.
 */
export const RecommendationRequestSchema = z.object({
  userId: z.string().uuid(),
  bucket: BucketSchema,
  /**
   * Hash of (sorted overdue ids, goal updated_at bucket, recent chat
   * theme bag). Same input → same cached output. Computed by the
   * caller.
   */
  stateHash: z.string().min(8),
  /** 1..3, default 3. */
  n: z.number().int().min(1).max(3).default(3),
})
export type RecommendationRequest = z.infer<typeof RecommendationRequestSchema>

export const RecommendationResponseSchema = z.object({
  bucket: BucketSchema,
  items: z.array(RecommendationItemSchema),
  generated_at: z.string().datetime(),
  cache: CacheStatusSchema,
})
export type RecommendationResponse = z.infer<typeof RecommendationResponseSchema>

/* -------------------------------------------------------------------------- */
/* State payload — what the route handler passes alongside the request       */
/* -------------------------------------------------------------------------- */

export const LackingSignalsSchema = z.object({
  bucket: BucketSchema,
  /** Themes extracted from overdue/dormant/stuck context (free text). */
  themes: z.array(z.string().min(1)).max(8).default([]),
  /** Number of overdue commitments, if applicable. */
  overdue_count: z.number().int().min(0).optional(),
  /** Avg slippage in days for overdue, if applicable. */
  avg_slippage_days: z.number().min(0).optional(),
  /** Days since last activity on any active goal. */
  days_since_last_activity: z.number().int().min(0).optional(),
})
export type LackingSignals = z.infer<typeof LackingSignalsSchema>

/* -------------------------------------------------------------------------- */
/* Reject-log entry                                                           */
/* -------------------------------------------------------------------------- */

/** What gets written to motivation_rejects for tuning later. */
export const RejectLogEntrySchema = z.object({
  url: z.string().url(),
  bucket: BucketSchema,
  score_breakdown: ScoreBreakdownSchema,
  weighted_total: z.number().min(0).max(10),
  /** Top 1-3 reasons the candidate failed. */
  top_reasons: z.array(z.string().min(1)).max(3),
  /** Which gate(s) the candidate failed. */
  gates_failed: z.array(z.enum(['core_four', 'k_of_n', 'weighted_total'])).min(1),
})
export type RejectLogEntry = z.infer<typeof RejectLogEntrySchema>
