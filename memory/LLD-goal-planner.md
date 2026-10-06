# LLD — Goal Planner & Replanner (OR-Tools–backed)

**Status:** implemented. Companion to `memory/HLD-goal-planner.md`.
**Owner:** main agent

---

## 1. Module map & dependency direction

```
app/api/chat/plan/route.ts            (HTTP; no domain logic)
        └─ lib/goal-planner/orchestrator.ts      (LangGraph pipeline)
              ├─ prompts.ts / schemas.ts / config.ts        (contracts)
              ├─ scheduler.ts      (buildLattice — pure structure)
              ├─ decompose.ts      (LLM content + placement)
              │     └─ horizon-solver.ts  (solveHorizon, planDailyFromLattice)
              │            └─ schedule.ts  (schedulePlan — week CP-SAT)
              ├─ headroom.ts / cross-validator.ts           (pure guardrails)
              └─ checkpointer.ts   (PostgresSaver | MemorySaver)
app/api/tools/confirm/route.ts
        └─ lib/proposal-executor.ts
              └─ lib/plan-relay.ts   (relayGoalPlan — replace plan_items)
lib/dashboard-state.ts ─ replan-suggestions.ts / drift-service.ts
```

Dependency rule: pure modules (`scheduler`, `schedule`, `horizon-solver`,
`headroom`, `cross-validator`, `drift`) never import DB or network. DB access
lives only in `proposal-executor`, `plan-relay`, `drift-service`, and routes.

## 2. Shared contracts

**Intent / mode** — `INTENTS = [add_goal, plan_day, edit_goal, drop_goal,
review_progress]`; `PLANNING_MODES = [auto, ask, grill]` (`schemas.ts`).

**Stage schemas (zod, single source of truth):**

| Schema | Shape |
|---|---|
| `IntakeSchema` | `{ shape, needs_clarification, clarifying_questions[], referenced_goal_titles[], framing_line }` |
| `PlanSchema` | `{ goal\|null, milestones[], blockers[], blocks[], availability?, prose }` |
| `PlanGoalSchema` | `{ title, horizon, why, first_action, start_date, target_date, weekly_hours, phase_objectives(2–4) }` |
| `PlanMilestoneSchema` | `{ title, target_date, phase, rationale }` |
| `EmitSchema` | `{ tools: [{ action, args }] }` (1–16) |
| `ToolActionSchema` | `create_goal, update_goal, drop_goal, pause_goal, set_goal_dates, add_milestone, add_blocker, add_block, set_availability` |

**Horizon vocabularies (distinct — do not conflate):**
- Goal size: `config.HORIZONS = [weekly, short, medium, long]` with
  `HORIZON_WINDOWS` (e.g. short = 30–90 d).
- Lattice grain: `scheduler.PLAN_HORIZONS = [daily, weekly, monthly,
  quarterly, yearly]` — the `plan_items.horizon` enum.

**Core row contracts:**
```ts
interface PlanItemRow { horizon: PlanHorizon; phase: string; title: string;
  note: string; start_date: string|null; end_date: string|null;
  due_date: string|null; weekly_hours: number|null }        // scheduler.ts

interface HorizonTask { id; title; phase; windowStart; windowEnd;
  estHours; priority /*1–5*/; order? }                       // horizon-solver.ts

interface ScheduleItem { id; priority; estHours; order?; earliest?;
  deadline? }                                                // schedule.ts
```

## 3. Pipeline graph (orchestrator.ts)

`StateGraph(PlannerState)`, compiled with a checkpointer. State annotations:
`intake, clarifyRounds, plan, planItems, headroom, emit, cvErrors,
emitAttempts, rejects(concat), modes(concat), result`.

```
START → n_intake ─┬─(needs_clarification)→ n_clarify ──▶ n_intake (loop)
                  ├─(early/conversational)─────────────▶ END
                  └─▶ n_plan ─▶ n_headroom ─▶ n_emit ⇄ n_cross_validate ─▶ END
```

| Node | Does | On failure |
|---|---|---|
| `n_intake` | classify shape; may set `needs_clarification` | reject → `no_change` |
| `n_clarify` | `interrupt()` — pause, persist, resume on answer; `clarifyRounds++` | — |
| `n_plan` | LLM plan → `buildLattice` → `decomposePlanItems` | reject → `no_change` (scheduler failure is non-fatal) |
| `n_headroom` | `checkHeadroom`; over budget → renegotiate result | — |
| `n_emit` | LLM tool proposals; drop ungrounded blockers | reject → `no_change` |
| `n_cross_validate` | `crossValidate`; retry emit once with the diff | 2nd fail → `no_change` |

Routers: `afterIntake`, `afterPlan`, `afterHeadroom`, `afterEmit`,
`afterCrossValidate` — each returns END when `result` is set.

**HITL:** `clarifyNode` calls LangGraph `interrupt(...)`; `getPendingPlanInterrupt`
(reads checkpoint state) lets the route decide resume-vs-fresh. Caps:
`MAX_CLARIFYING_ROUNDS = 2`, `MAX_RENEGOTIATION_ROUNDS = 2`.

## 4. Scheduler LLD

### 4.1 `buildLattice(input): SchedulerResult` — deterministic structure

Pure. Owns phase spans, milestone dates, week bands, and the 20% buffer
(`BUFFER_RATIO = 0.2`).

```
total = daysBetween(start, target);  if total < 7 → target = start+7, total = 7
spans[i] = [ start + round(i·total/n), start + round((i+1)·total/n) ]   // n = phases; n=0 → 1 span
winEnd(span) = span.start + (1-0.2)·span_len          // effective (80%) window
for each span:
  seg = daysBetween(span.start, winEnd) / k           // k = milestones in phase
  milestone j: target   = min(span.start + round((j+1)·seg), span.end)
               workStart = span.start + round(j·seg·0.5)   // parallel tracks
  weekly bands: w = span.start; step 7 until winEnd
    active = { m : m.workStart ≤ bandEnd ∧ m.target ≥ bandStart }
    label  = active.length>1 ? title + ' — part i/N' : title
  daily: one row per calendar day × active label;
         perDay = weekly_hours / daysInBand / activeCount
emit quarterly (per span) and yearly (goal span) rows
```

Output `items: PlanItemRow[]` in order yearly → quarterly → monthly → weekly
→ daily; `milestones` re-dated; `spans` for the UI.

### 4.2 `solveHorizon(input): Promise<HorizonResult>` — plan-wide CP-SAT

Primary placer (new). One model for the whole plan.

```
candidate days D = ⋃ window(t)   ;  cap[d] = blocked(d) ? 0
                                  : (dailyCapHours ?? availability[weekday(d)])
need[t] = max(1, round(estHours(t)·10))            // tenths of an hour

vars   b[t][d] ∈ {0,1}  for d ∈ window(t)
constr Σ_d b[t][d] ≤ 1                              // at most one sitting
       Σ_t need[t]·b[t][d] ≤ cap[d]  ∀d             // per-day capacity
       cap[d] < need[t] ⇒ b[t][d] = 0   ∀(t,d)      // fit
obj    max Σ prio(t)·1000·b[t][d]  −  Σ idx(d)·b[t][d]
solve  CpSat.solve(m, { numWorkers: 1 })
```
Returns `{ feasible, slots[{taskId,date,hours}], unscheduled[], solver }`.
**Fallback:** greedy (priority desc, earliest day with room) on any import/
solve error or when `!res.hasSolution`.

### 4.3 `schedulePlan(input): Promise<ScheduleResult>` — week scope

Retained for `decomposeAndScheduleWeek` and the dev spike. Same CP-SAT shape
bounded to 7 days, with an added soft precedence constraint over `order`.

## 5. Decompose LLD

### `decomposePlanItems(rows, {availability, blockedDates, provider, complete})`
Guard: no availability or no weekly rows → return `rows` unchanged.

1. **Content (LLM)** — per weekly row, `decomposePrompt` → ≤7 verb-led steps
   (`DecomposeSchema`). Failure → `fallbackSteps` (`<week> — step k/N`).
   Build one `HorizonTask` per step: `window = [week.start, week.end]`,
   `estHours = step.hours ?? weekly_hours/steps`, `priority = 3`.
2. **Placement (solver)** — **one** `solveHorizon` over all steps, plan-wide.
3. **Map** — slots → `daily` rows `Fulfils "<title>" · <h>h`; unscheduled steps
   kept at `windowStart` marked `(over capacity)` so no work vanishes;
   non-daily rows pass through.

### `planDailyFromLattice(rows, {availability, blockedDates})`
No-LLM sibling used by the relay: places each *weekly checkpoint* on a day
(titles = weekly titles). Same `solveHorizon`.

### `decomposeAndScheduleWeek(...)`
Legacy single-week API (LLM steps → `schedulePlan`); retained for tests/back
compat.

## 6. Persistence LLD

### 6.1 Confirm path (`route.ts` → `confirm/route.ts` → `proposal-executor.ts`)
- `result.planItems` is attached to **one carrier** proposal: first
  `create_goal`, else `add_milestone`/`add_commitment` (`plan/route.ts`).
- `applyCreateGoal` writes `goal` + `plan_items` in one transaction via
  `writePlanItems`; `applyAddMilestone` also calls `writePlanItems`.
- `writePlanItems(tx, schema, {userId, goalId, items})` — maps id-less rows
  to `plan_items` (validates `horizon` ∈ 5; **insert-only**).

### 6.2 Re-lay path (`plan-relay.ts → relayGoalPlan`)
```
relayGoalPlan(userId, goalId):
  read goal (skip if dropped) + milestones (skip if none)
  read availability + blockers → blockedDates[]
  scheduled = buildLattice({...})
  if availability: items = planDailyFromLattice(items, ...)   // CP-SAT
  tx { move non-done milestones → scheduled dates;
       DELETE plan_items WHERE goal_id;  INSERT new rows }     // replace, not append
```
All imports are dynamic (`@/lib/db`, schema, scheduler, horizon-solver) so
importing the module never triggers `server-only` env validation. Called
best-effort (`.catch(() => {})`) after `applyUpdateGoal` and
`applySetGoalDates`.

## 7. Guardrail LLD

### `checkHeadroom` (pure)
| Condition | Decision |
|---|---|
| `budget == null` | `advisory` |
| any active goal missing `weekly_hours` | `advisory` |
| `total ≤ budget` | `proceed` |
| `free ≥ −CAP_TIGHT_SLACK_HOURS (−5)` | `proceed_tight` |
| else | `renegotiate` (4 buttons) |

### `crossValidate` (pure) — every emitted tool must trace to the plan
- action ∈ `ALLOWED_ACTIONS[intent]`;
- args match `ACTION_ARG_SCHEMAS[action]`;
- `add_milestone.target_date` ∈ plan milestone dates; `phase` ∈
  `phase_objectives` keys; `goal_title` known;
- `add_blocker` dates ∈ plan blockers; `add_block` ∈ plan blocks and within
  today..today+2; `create_goal.title` == `plan.goal.title`;
- `add_goal`: goal present and 3–8 milestones.

### Anti-hallucination blocker gate (orchestrator)
Model-produced blockers are cleared unless `messageMentionsBlocker(message)`
(a cue regex over the user's own words).

## 8. Replan LLD

### `computeReplanSuggestions(input): ReplanSuggestion[]` (pure, no I/O)
| Trigger | Fires when |
|---|---|
| `drift` | active goal `drift_status === 'at_risk'` |
| `infeasible_edit` | recent goal date/hour edit ⇒ past target / inverted dates / milestones-after-target / over budget |
| `timetable_collision` | goal-linked block outside the goal window or on a blocker |
| `blocker_collision` | blocker window overlaps an active goal window |
| `capacity_freed` | drop/pause in the last 7 d with `freed_weekly_hours > 0` and other goals active |
Sorted by priority, capped at 5. `REPLAN_INTENT[*] = 'review_progress'`.

### `computeDrift` / `recomputeGoalDrift`
Rule: a milestone `target_date < today` and `status != 'done'` ⇒ `at_risk`.
`recomputeGoalDrift(userId, goalIds?)` persists `goals.drift_status` + audits
the transition; called after daily-log / blocker changes and on a daily
dashboard miss.

## 9. Route contract — `POST /api/chat/plan`

Request: `{ message, kind, refId?, scope?, provider?, title?, helperText?,
sourceIds?, autoAnswer?, grillMe?, renegotiation? }`.

| Response `status` | Meaning | Payload |
|---|---|---|
| `disabled` | flag off → client falls back to `/chat/stream` | — |
| `not_planned` | kind not in the 5 intents | — |
| `clarify` | HITL question(s) | `prose, questions` |
| `early` | conversational early-return | `shape, prose` |
| `no_change` | a stage failed; client falls back | `prose, reason` |
| `renegotiate` | over budget | `headroom, options[4], plan, plan_items` |
| `ok` | proposals ready | `proposals[], headroom, plan, plan_items` |

Also: a deterministic **forced-drop** net (resolve target from message +
conversation title when the pipeline emits no drop tool), and a drop-impact
preview attached to each `drop_goal` proposal.

## 10. Config (`goal-planner/config.ts`)

`GOAL_PLANNER_ENABLED` (default **on**), `GOAL_PLANNER_USER_ALLOWLIST`,
`MIN/MAX_WEEKLY_HOURS = 1/20`, `MIN/MAX_PHASES = 2/4`, `MIN/MAX_MILESTONES =
3/8`, `MAX_BLOCKERS = 3`, `MAX_PLAN_BLOCKS = 8`, `MAX_TOOLS = 16`,
`MAX_CLARIFYING_QUESTIONS = 6`, `MAX_CLARIFYING_ROUNDS = 2`,
`MAX_RENEGOTIATION_ROUNDS = 2`, `CAP_TIGHT_SLACK_HOURS = 5`,
`BUFFER_RATIO = 0.2`, `HORIZON_WINDOWS`, `PIPELINE_TIMEOUT_MS` (55 s).

## 11. Fallback / error matrix

| Stage | Failure | Result |
|---|---|---|
| intake | LLM error | `no_change` + `plan_rejects` |
| plan | LLM error / empty | `no_change` (or one corrective retry) |
| lattice | arithmetic error | plan proceeds, `planItems = []` |
| decompose | LLM error | `fallbackSteps` then still solved |
| solver | import/solve error | greedy allocator |
| greedy | still infeasible | unscheduled surfaced / kept as overflow |
| headroom | incomplete load | `advisory`, never auto-renegotiate |
| emit | LLM error | retry once, then `no_change` |
| cross-validate | mismatch | retry emit once, then `no_change` |
| relay | any error | swallowed (mutation already committed) |

## 12. Tests (72 passing, 11 files, `lib/goal-planner/__tests__`)

`scheduler` (12), `cross-validator` (10), `orchestrator` (18), `headroom` (6),
`llm` (5), `intake-availability` (2), `drift` (4), `schedule` (5, real CP-SAT),
`decompose` (3), **`horizon-solver` (5, real CP-SAT)**, **`decompose-plan`
(2, plan-wide)**.

Solvers are exercised against the real `or-tools-wasm` runtime in CI
(`schedule.test.ts`, `horizon-solver.test.ts` include real solves).
