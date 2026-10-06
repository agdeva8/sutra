# HLD — Goal Planner & Replanner (OR-Tools–backed)

**Status:** implemented — deterministic lattice + plan-wide CP-SAT day placement + replan relay. Universal action-intake remains.
**Owner:** main agent
**Related:** `memory/scheduling-design.md`, `memory/PRD-goal-planner.md`, `memory/HLD-drop-goal-cascade.md`

---

## 1. Problem

A coaching app must turn one sentence ("switch jobs in 3 months") into a dated
plan across five horizons — **yearly › quarterly › monthly › weekly › daily** —
and then keep that plan true as the user acts (logs a day, adds/removes a
source, adds a blocker, edits a goal or a date). Two jobs were conflated and
the second (re-planning) was effectively missing:

- **Meaning** — goal, phases, milestones, task titles — belongs to an LLM.
- **Dates / placement** — when each piece happens under real availability —
  belongs to a solver. It was being done by hand-written arithmetic
  (`buildLattice`), which stamped a task on *every calendar day*, ignored
  availability, and never re-ran when the goal changed.

## 2. Goals / non-goals

**Goals**
1. One typed pipeline that plans a goal across all five horizons.
2. A CP-SAT solver owns date placement, availability-aware and priority-aware.
3. Re-planning: a change re-lays the plan instead of leaving it stale or
   duplicating it.
4. Never block on a model/solver failure — always degrade to a valid plan.
5. Human-in-the-loop: nothing semantic is written without confirmation.

**Non-goals**
- Multi-goal joint optimisation in one inference (post-MVP).
- ML drift prediction (drift stays rule-based).
- Realtime SSE rewrite of the legacy `general` chat path.

## 3. System context

```
 React (CRA)                     Next.js 16 API                 Postgres
 ─────────────                   ───────────────                ────────
 ChatModal / Coach.js  ──plan──▶ POST /api/chat/plan
   use-plan-send.js               └─ LangGraph planner ──▶ LLM (Gemini/…)
 Today / Timeline / Plan            ├─ buildLattice  (structure)
   PlanBreakdown.jsx                ├─ solveHorizon  (CP-SAT, OR-Tools)
   ReplanSuggestions.jsx            ├─ headroom / cross-validator (pure)
                                    └─ proposals ─────────▶ goals, milestones,
 confirm card ──confirm──▶ POST /api/tools/confirm          plan_items, blockers,
                                    └─ proposal-executor     audit_log, proposals
                                        └─ relayGoalPlan (re-lay plan_items)
 dashboard ◀── /api/state ── state-builder + replan-suggestions
```

## 4. Architecture — two engines, one pipeline

| Layer | Owns | Module |
|---|---|---|
| LLM | meaning: goal, phases(2–4), milestones, task content, prose | `goal-planner/prompts.ts` + provider client |
| Deterministic scheduler | **structure + dates**: phase spans, milestone dates, week bands, the 20% buffer | `goal-planner/scheduler.ts` (`buildLattice`) |
| **CP-SAT solver (OR-Tools)** | **placement**: which DAY each piece lands on, under availability/blockers/capacity/priority | `goal-planner/horizon-solver.ts` (`solveHorizon`, `planDailyFromLattice`); week helper `schedule.ts` (`schedulePlan`) |
| Guardrails (pure) | headroom, cross-validation, blocker gate | `headroom.ts`, `cross-validator.ts`, `orchestrator.ts` |
| Planner graph | orchestration + HITL | `orchestrator.ts` (LangGraph `StateGraph`) |
| Persistence | proposals → confirm → rows | `proposal-executor.ts`, `plan-relay.ts` |

**The boundary is locked:** the solver never invents meaning; the LLM never
owns dates.

## 5. Plan creation flow (happy path)

1. User sends a message on a *planned* intent → `POST /api/chat/plan`.
2. `intake` classifies shape; may `clarify` via a real LangGraph `interrupt()`
   (durable, resumable).
3. `plan` → LLM returns goal + 2–4 phases + 3–8 milestones.
4. `buildLattice` lays the structure (phase spans, milestone dates, weekly
   bands, 20% per-horizon buffer).
5. `decomposePlanItems` → LLM writes distinct weekly steps, then **one
   plan-wide CP-SAT solve** (`solveHorizon`) places every step on a day.
6. `headroom` (pure) checks capacity; `emit` (LLM) proposes tool actions;
   `cross_validate` (pure) proves each tool traces to the plan.
7. User confirms; `proposal-executor` writes `goal` + `plan_items` in one
   transaction; user sees the plan.

## 6. Re-plan flow (event → agent → solver → confirm)

```
 user action (edit goal, move date, add blocker, drop/pause, drift… )
        │
   computeReplanSuggestions()  ── deterministic, opt-in  ──▶ dashboard banner
        │  (user taps Re-plan → review_progress chat)
        ▼
 planner pipeline  →  LLM decides blast area  →  proposals (update_goal,
 set_goal_dates, add_milestone, add_blocker, pause/drop)
        ▼  user confirms
 proposal-executor applies the change  ──▶  relayGoalPlan()
        └─ buildLattice + solveHorizon  ⇒  DELETE + INSERT plan_items (replace)
```

Two re-lay triggers are wired today: `update_goal` and `set_goal_dates` both
call `relayGoalPlan`, which **replaces** the goal's `plan_items` and moves its
open milestones onto the scheduler's dates.

## 7. Data model (relevant)

| Table | Role | Key columns |
|---|---|---|
| `goals` | the goal | `title, horizon, start_date, target_date, weekly_hours, phase_objectives(jsonb), drift_status, status` |
| `milestones` | monthly-level commitments | `goal_id, title, target_date, phase, status` |
| `plan_items` | **the schedule of record** (all 5 horizons) | `goal_id, horizon, phase, title, note, start_date, end_date, due_date, weekly_hours, status` |
| `blockers` | date windows that remove capacity | `start_date, end_date` |
| `users` | capacity + availability | `available_weekly_hours, availability(jsonb {mon..sun → hours})` |
| `proposals` | pending user-confirmable actions | `action, args(jsonb), status` |
| `plan_rejects` | pipeline observability | `intent, stage, reason, recovered` |

`plan_items.horizon ∈ {daily, weekly, monthly, quarterly, yearly}`. FK
`ON DELETE CASCADE` to `goals` — but goals are soft-deleted, so cascade never
fires (see §11).

## 8. Locked design decisions

- **A. Meaning / dates split** — LLM owns meaning, solver owns dates (§4).
- **B. Write buckets** — scheduling fields (`plan_items` dates) are solver-
  written (direct); semantic fields (titles, scope) are coach-confirmed.
- **C. 20% buffer per horizon** — every span schedules into its first 80%; the
  tail absorbs slips before they propagate up.
- **D. Priority 1–5** — weights the solver objective; protected first under
  infeasibility.
- **E. Objective** — maximise priority-weighted coverage, tie-break front-load.
- **F. Propose → confirm** — nothing semantic is written without the user.
- **G. Fallback everywhere** — CP-SAT → greedy → deterministic lattice.

## 9. OR-Tools: role and as-built shape

`or-tools-wasm` (CP-SAT, ~7 MB, Node) is added as a **tool the pipeline runs**, 
not a service. Two call sites:

1. **`solveHorizon`** (new, primary) — plan-wide: all the plan's work items
   solved in **one** model against availability/blockers/capacity/priority.
2. **`schedulePlan`** (week scope) — retained; backs `decomposeAndScheduleWeek`
   and the `dev-only/schedule-spike` probe.

Both write the same `plan_items` contract and fall back deterministically.

> Deviation from `scheduling-design.md`: the doc framed CP-SAT as an
> *LLM-callable tool* owning month→week→day. As built, the solver is invoked
> **deterministically by the pipeline** (not by an LLM tool call) and owns
> **week→day** placement; month/quarter placement stays structural in
> `buildLattice`. Reconciling the doc is tracked in §11.

## 10. Non-functional

- **Reliability** — no model/solver failure ever 500s the plan; each stage has
  a fallback and the pipeline returns `no_change` at worst.
- **Determinism** — `buildLattice` is pure (identical input ⇒ identical
  lattice); the solver is deterministic for these small models.
- **Latency** — master deadline `GOAL_PLANNER_TIMEOUT_MS` (default 55 s) under
  `maxDuration = 60`.
- **Rollout** — `GOAL_PLANNER_ENABLED` (default on) + optional user allowlist.
- **Observability** — every reject is persisted to `plan_rejects`.

## 11. Gaps & roadmap

| # | Gap | Impact |
|---|---|---|
| 1 | Not every action reaches the agent (daily-log, blocker add, milestone edit are direct CRUD) | replan is opt-in, not universal |
| 2 | Re-lay wired only for `update_goal` / `set_goal_dates` — not blocker/status changes | those leave the lattice stale |
| 3 | `writePlanItems` **appends** when reached via `add_milestone` | duplicate lattice if a re-plan emits one |
| 4 | Dropping a goal **orphans** `plan_items` (soft delete; cascade never fires) | unbounded dead rows |
| 5 | Confirm route applies the side effect before the optimistic status flip | double-apply race |
| 6 | No validation at the persistence boundary (`writePlanItems` trusts args) | malformed rows possible |
| 7 | `scheduling-design.md` describes an LLM tool-node solver not built | doc drift (§9) |

## 12. Component inventory

| Path | Responsibility |
|---|---|
| `api/app/api/chat/plan/route.ts` | HTTP entry, flag gate, carrier logic, persistence of messages/proposals |
| `api/lib/goal-planner/orchestrator.ts` | LangGraph pipeline (6 nodes) |
| `api/lib/goal-planner/scheduler.ts` | `buildLattice` — structural lattice + 20% buffer |
| `api/lib/goal-planner/horizon-solver.ts` | `solveHorizon`, `planDailyFromLattice` — plan-wide CP-SAT |
| `api/lib/goal-planner/schedule.ts` | `schedulePlan` — week-scope CP-SAT + greedy |
| `api/lib/goal-planner/decompose.ts` | LLM step content + plan-wide placement wiring |
| `api/lib/goal-planner/{schemas,prompts,config}.ts` | contracts, prompts, tunables |
| `api/lib/goal-planner/{headroom,cross-validator,drift}.ts` | pure guardrails |
| `api/lib/plan-relay.ts` | `relayGoalPlan` — replace `plan_items` on change |
| `api/lib/proposal-executor.ts` | apply confirmed proposals |
| `api/lib/replan-suggestions.ts` | deterministic replan triggers |
| `frontend/src/components/PlanBreakdown.jsx` | renders the lattice |
| `frontend/src/components/ReplanSuggestions.jsx` | the opt-in replan banner |
