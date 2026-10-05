/**
 * Motivation agent — barrel export.
 *
 * Server-only. The route handler at
 * api/app/api/motivation/recommend/route.ts imports `recommend` from
 * here. Nothing in this barrel is imported by client code.
 */

import 'server-only'

export {
  // Enums
  BucketSchema,
  CacheStatusSchema,
  CritiqueVerdictSchema,
  KindSchema,
  // Scoring
  SCORE_KEYS,
  SCORE_WEIGHTS,
  CORE_PARAMS,
  ScoreBreakdownSchema,
  // Schemas
  CandidateSchema,
  ScoredCandidateSchema,
  RecommendationItemSchema,
  RecommendationRequestSchema,
  RecommendationResponseSchema,
  LackingSignalsSchema,
  RejectLogEntrySchema,
  // Types
  type Bucket,
  type CacheStatus,
  type CritiqueVerdict,
  type Kind,
  type ScoreKey,
  type ScoreBreakdown,
  type Candidate,
  type ScoredCandidate,
  type RecommendationItem,
  type RecommendationRequest,
  type RecommendationResponse,
  type LackingSignals,
  type RejectLogEntry,
} from './schema'

export {
  // Feature flag
  MOTIVATION_AGENT_ENABLED,
  // Keys
  TAVILY_API_KEY,
  REASONING_MODEL,
  CHEAP_MODEL,
  REASONING_PROVIDER,
  CHEAP_PROVIDER,
  // Pipeline bounds
  PIPELINE_TIMEOUT_MS,
  STAGE_TIMEOUTS,
  MAX_SEARCH_QUERIES,
  MAX_CANDIDATES_FETCHED,
  MAX_LLM_CRITIQUES,
  DAILY_USER_CAP,
  // Cost
  COST_CAP_USD,
  llmCallCostUsd,
  tavilyCostUsd,
  // Thresholds
  PER_PARAM_FLOOR,
  K_OF_N_MIN,
  K_OF_N_TOTAL,
  WEIGHTED_TOTAL_FLOOR,
  // Cache TTLs
  CACHE_TTL_MS,
  STALE_TTL_MS,
  REJECT_LOG_TTL_MS,
  // Helpers
  computeWeightedTotal,
  passesCoreFour,
  countAboveFloor,
} from './config'

export { recommend } from './recommend'
export {
  extractLackingSignals,
  computeStateHash,
} from './state'
export { pickTopN, persistRejects } from './picker'
export { frameCandidate, fallbackFrame } from './frame'
export { critiqueCandidate } from './critique'
export { fetchCandidates } from './fetch'
export { searchTavily } from './search'
