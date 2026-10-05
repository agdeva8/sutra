/**
 * Goal Planner (Iteration 10) — barrel.
 *
 * Pure modules only. The LLM-backed orchestrator (`recommend`-equivalent)
 * lands in Slice 3 and is intentionally NOT exported here yet, so importing
 * this barrel never pulls in a provider client.
 */

export * from './config'
export * from './schemas'
export * from './headroom'
export * from './cross-validator'
export * from './drift'
export * from './scheduler'
export * from './schedule'
export * from './decompose'
