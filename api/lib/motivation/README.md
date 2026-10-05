# Motivation Agent

LLM-driven curation for the existing `MotivationCard`. A pipeline that
searches the live web, critiques candidates against 10 parameters, and
returns the top 3 only if they pass three gates (core-four, k-of-n,
weighted total). There is no hand-curated fallback: on a cold miss the
card shows a "searching" line until the pipeline lands picks.

## Layout

```
api/lib/motivation/
  schema.ts    Zod shapes — single source of truth for the pipeline
  config.ts    env, model names, thresholds, cost cap, helpers
  index.ts     barrel (server-only)
  (future)     search.ts, fetch.ts, critique.ts, picker.ts,
               frame.ts, cache.ts, state.ts, recommend.ts
```

## Pipeline (single request, runs inline)

1. `state.ts` extracts "lacking" signals from bucket + state hash
2. `search.ts` calls Tavily with 3-5 queries
3. `fetch.ts` pulls each URL (3s/URL cap) and normalizes to `Candidate`
4. `critique.ts` LLM-scores each candidate on 10 params
5. `picker.ts` applies the three gates, picks top 3 with diversity
6. `frame.ts` writes the per-item "right now, X" sentence
7. `cache.ts` writes to `motivation_cache` (60m TTL)
8. Returns to `api/app/api/motivation/recommend/route.ts`

## Scorecard

| # | Param | Weight | Hard gate (must > 0.6) |
|---|---|---|---|
| 1 | Source credibility | 0.15 | ★ core |
| 2 | Recency | 0.10 | ★ core |
| 3 | Content depth | 0.15 | ★ core |
| 4 | Actionability | 0.15 | ★ core |
| 5 | Citation density | 0.10 | |
| 6 | Engagement volume | 0.08 | |
| 7 | Engagement quality | 0.08 | |
| 8 | Voice fit | 0.08 | |
| 9 | Source independence | 0.06 | |
| 10 | Accessibility | 0.05 | |

All three gates must pass:
1. **Core four** — each of params 1/2/3/4 individually > 0.6
2. **k-of-n** — at least 5 of 10 params individually > 0.6
3. **Weighted total** — weighted sum ≥ 6.5 / 10

## Env vars

| Var | Purpose |
|---|---|
| `MOTIVATION_AGENT_ENABLED` | Master switch. Default: on except `NODE_ENV=test` |
| `TAVILY_API_KEY` | Required when the agent is enabled |
| `EMERGENT_LLM_KEY` | Already used by `lib/emergent/llm.ts` |

## Rollout flag

`MOTIVATION_AGENT_ENABLED` is on by default everywhere except the
test runner. Set it to `false` to disable the pipeline (the route then
returns the empty "searching" response).

## Cost cap

Hard ceiling $0.25 / call. Live-tracked by the orchestrator from
token counts × published rates. On breach, short-circuit to the empty
"searching" response.

## Failover chain

1. Cache hit (≤ 60m) → return immediately
2. Cache stale (≤ 24h) → return stale items, refresh in background
3. Cache miss → return empty (`cache: 'miss'`), pipeline runs in
   background; the card shows "Searching the web…" and polls
4. Pipeline failure / cap breach / Tavily missing → empty response;
   the card gives up after its poll cap and offers a retry
