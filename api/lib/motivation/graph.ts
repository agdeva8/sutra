/**
 * Motivation agent — LangGraph StateGraph.
 *
 * The pipeline (extract signals → Tavily search → fetch → 10-param critique →
 * picker → frame → cache write) was a linear function. It is now an explicit
 * graph so it matches the rest of the system (AI SDK stages + LangGraph
 * orchestration) and so the stage-level cost/timeout short-circuits are
 * edges rather than nested returns.
 *
 * Every LLM stage already goes through the shared AI SDK client
 * (`lib/llm/client.ts`) via `critique.ts` / `frame.ts`.
 *
 * Budgets (all live in config.ts) are owned by the caller (`recommend.ts`)
 * via the abort signal; the graph short-circuits to the empty "searching"
 * response on any stage failure, cost-cap breach, or empty stage output —
 * it never throws.
 */

import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph'

import { COST_CAP_USD, STAGE_TIMEOUTS, llmCallCostUsd, tavilyCostUsd } from './config'
import { bumpServedCount, writeCache } from './cache'
import { critiqueCandidate } from './critique'
import { fetchCandidates } from './fetch'
import { frameCandidate } from './frame'
import { persistRejects, pickTopN } from './picker'
import { searchTavily } from './search'
import { extractLackingSignals } from './state'
import type {
  Bucket,
  Candidate,
  RecommendationItem,
  RecommendationResponse,
  ScoredCandidate,
} from './schema'

/**
 * Max critiques in flight at once. Caps the burst we throw at the
 * Emergent proxy per-key budget. 5 was chosen empirically.
 */
const CRITIQUE_CONCURRENCY = 5

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const MotState = Annotation.Root({
  signals: Annotation<{ themes: string[] } | null>({ reducer: (_a, b) => b, default: () => null }),
  queries: Annotation<string[]>({ reducer: (_a, b) => b, default: () => [] }),
  raw: Annotation<Awaited<ReturnType<typeof searchTavily>>>({ reducer: (_a, b) => b, default: () => [] }),
  candidates: Annotation<Candidate[]>({ reducer: (_a, b) => b, default: () => [] }),
  scored: Annotation<ScoredCandidate[]>({ reducer: (_a, b) => b, default: () => [] }),
  picks: Annotation<ScoredCandidate[]>({ reducer: (_a, b) => b, default: () => [] }),
  items: Annotation<RecommendationItem[]>({ reducer: (_a, b) => b, default: () => [] }),
  result: Annotation<RecommendationResponse | null>({ reducer: (_a, b) => b, default: () => null }),
})

type MotUpdate = typeof MotState.Update

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

export interface MotivationGraphArgs {
  userId: string
  bucket: Bucket
  stateHash: string
  n: number
  signal: AbortSignal
  /** Deterministic fallback (empty "searching") response. */
  fallback: () => RecommendationResponse
  checkpointer?: BaseCheckpointSaver
}

export function buildMotivationGraph(args: MotivationGraphArgs) {
  const { userId, bucket, stateHash, n, signal, fallback } = args

  const cost = new CostTracker()
  const generatedAt = new Date().toISOString()

  /* Stage 1 — signals + queries */
  const signalsNode = async (): Promise<MotUpdate> => {
    const signals = await extractLackingSignals({ userId, bucket })
    return { signals: { themes: signals.themes }, queries: buildQueries(bucket, signals.themes) }
  }

  /* Stage 2 — search */
  const searchNode = async (s: typeof MotState.State): Promise<MotUpdate> => {
    const raw = await searchTavily({ queries: s.queries, signal })
    cost.recordTavily(tavilyCostUsd(s.queries.length))
    if (cost.overBudget()) return { result: fallback() }
    if (raw.length === 0) return { result: fallback() }
    return { raw }
  }

  /* Stage 3 — fetch + normalize */
  const fetchNode = async (s: typeof MotState.State): Promise<MotUpdate> => {
    const candidates = await fetchCandidates({ results: s.raw, bucket, signal })
    if (candidates.length === 0) return { result: fallback() }
    return { candidates }
  }

  /* Stage 4 — critique in parallel (per-candidate isolation) */
  const critiqueNode = async (s: typeof MotState.State): Promise<MotUpdate> => {
    const scored = await critiqueAll({
      candidates: s.candidates,
      sessionId: userId,
      signal,
      onCost: (usd) => cost.recordLlm('reasoning', usd),
      onCap: () => cost.overBudget(),
    })
    if (cost.overBudget()) return { result: fallback() }
    if (scored.length === 0) return { result: fallback() }
    return { scored }
  }

  /* Stage 5 — pick */
  const pickNode = async (s: typeof MotState.State): Promise<MotUpdate> => {
    const { picks, rejected } = pickTopN({ scored: s.scored, n, bucket })
    void persistRejects(userId, bucket, rejected)
    if (picks.length === 0) return { result: fallback() }
    return { picks }
  }

  /* Stage 6 — frame */
  const frameNode = async (s: typeof MotState.State): Promise<MotUpdate> => {
    const items = await Promise.all(
      s.picks.map(async (c) => {
        const frame = await frameCandidate({ candidate: c, bucket, sessionId: userId })
        return toRecommendationItem(c, frame)
      }),
    )
    return { items }
  }

  /* Stage 7 — cache write (best effort) + result */
  const cacheNode = async (s: typeof MotState.State): Promise<MotUpdate> => {
    void bumpServedCount(userId)
    await writeCache({ userId, bucket, stateHash, items: s.items }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[motivation] cache write failed:', err)
    })
    return {
      result: { bucket, items: s.items, generated_at: generatedAt, cache: 'miss' },
    }
  }

  const route = (next: string) => (s: typeof MotState.State): string => (s.result ? END : next)

  return new StateGraph(MotState)
    .addNode('n_signals', signalsNode)
    .addNode('n_search', searchNode)
    .addNode('n_fetch', fetchNode)
    .addNode('n_critique', critiqueNode)
    .addNode('n_pick', pickNode)
    .addNode('n_frame', frameNode)
    .addNode('n_cache', cacheNode)
    .addEdge(START, 'n_signals')
    .addEdge('n_signals', 'n_search')
    .addConditionalEdges('n_search', route('n_fetch'), { n_fetch: 'n_fetch', [END]: END })
    .addConditionalEdges('n_fetch', route('n_critique'), { n_critique: 'n_critique', [END]: END })
    .addConditionalEdges('n_critique', route('n_pick'), { n_pick: 'n_pick', [END]: END })
    .addConditionalEdges('n_pick', route('n_frame'), { n_frame: 'n_frame', [END]: END })
    .addConditionalEdges('n_frame', route('n_cache'), { n_cache: 'n_cache', [END]: END })
    .addEdge('n_cache', END)
    .compile(args.checkpointer ? { checkpointer: args.checkpointer } : {})
}

/** Run the motivation graph and always return a response (never throws). */
export async function runMotivationGraph(args: MotivationGraphArgs): Promise<RecommendationResponse> {
  try {
    const graph = buildMotivationGraph(args)
    const out = (await graph.invoke({})) as typeof MotState.State
    return out.result ?? args.fallback()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[motivation] graph failed:', e instanceof Error ? e.message : e)
    return args.fallback()
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers (moved from recommend.ts)                                          */
/* -------------------------------------------------------------------------- */

interface CritiqueAllArgs {
  candidates: Candidate[]
  sessionId: string
  signal: AbortSignal
  onCost: (usd: number) => void
  onCap: () => boolean
}

/** Bounded-concurrency critique with per-candidate failure isolation. */
async function critiqueAll(args: CritiqueAllArgs): Promise<ScoredCandidate[]> {
  const { candidates, sessionId, signal, onCost, onCap } = args
  const scored: ScoredCandidate[] = []

  let cursor = 0
  async function worker() {
    while (true) {
      if (onCap()) return
      const idx = cursor++
      if (idx >= candidates.length) return
      const c = candidates[idx]
      try {
        const result = await critiqueCandidate({ candidate: c, sessionId, signal })
        onCost(estimateCritiqueCost(result))
        scored.push(result)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[motivation] critique dropped:', err instanceof Error ? err.message : err)
      }
    }
  }

  const workers: Promise<void>[] = []
  const pool = Math.min(CRITIQUE_CONCURRENCY, candidates.length)
  for (let i = 0; i < pool; i++) workers.push(worker())
  await Promise.all(workers)
  return scored
}

function buildQueries(bucket: Bucket, themes: string[]): string[] {
  const themeBit = themes.length > 0 ? `${themes.slice(0, 2).map(quote).join(', ')} ` : ''
  const byBucket: Record<Bucket, string> = {
    overdue:
      `practical micro-habits for breaking a ${themeBit}procrastination streak ` +
      `(start in 2 minutes)`,
    dormant:
      `reconnecting with the why behind ${themeBit || 'a goal you stopped working on'} ` +
      `(first-person, concrete)`,
    stuck:
      `breaking through the boring middle of ${themeBit || 'a long-running goal'} ` +
      `(concrete frame, not motivation)`,
  }
  const base = byBucket[bucket]
  return [
    base,
    base.replace(/\(.*\)/, '(original practitioner voice)'),
    base.replace(/\(.*\)/, '(research, primary source)'),
  ]
}

function quote(s: string): string {
  const t = s.trim()
  if (!t) return ''
  return t.length < 30 ? `${t} ` : `${t.slice(0, 30)} `
}

function toRecommendationItem(c: ScoredCandidate, frame: string): RecommendationItem {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    author: c.author,
    url: c.url,
    duration: c.duration,
    frame,
    excerpt: c.excerpt,
    score_total: Math.round(c.weighted_total * 10) / 10,
  }
}

function estimateCritiqueCost(scored: ScoredCandidate): number {
  const inputChars = scored.title.length + scored.excerpt.length + 600
  const outputChars = 400
  return llmCallCostUsd('reasoning', Math.ceil(inputChars / 4), Math.ceil(outputChars / 4))
}

/* -------------------------------------------------------------------------- */
/* Cost tracker                                                               */
/* -------------------------------------------------------------------------- */

class CostTracker {
  private totalUsd = 0
  recordTavily(usd: number): void {
    this.totalUsd += usd
  }
  recordLlm(_kind: 'reasoning' | 'cheap', usd: number): void {
    this.totalUsd += usd
  }
  overBudget(): boolean {
    return this.totalUsd >= COST_CAP_USD
  }
  getTotal(): number {
    return this.totalUsd
  }
}
