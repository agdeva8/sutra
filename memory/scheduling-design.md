# Design — Availability capture + solver-native multi-horizon scheduling

**Status:** draft for founder review (not built). Companion to `memory/PRD.md` (Iteration 10 Goal Planner) and `memory/AGENT_BUILDER.md`.

**One line:** the LLM owns *meaning* (goal → phases → milestones, with 1–5 priority) and *task content*; a deterministic **CP-SAT solver** is exposed as a **single tool** the LLM calls in the graph to lay the plan out top-down **month → week → day** under availability/capacity/deadline constraints. Small changes re-solve silently; only infeasibility or a scope change escalates to a user-confirmed replan.

---

## 0. Prerequisite slice — remove commitments (app-wide) · LOCKED

**Decision A:** commitments are removed as a concept, everywhere, because they're creating issues. The scheduling model below assumes no commitment layer.

**Caveat:** the `over_commitment` **indicator** (the capacity signal shown on the dashboard: "you're over-committed") is a *different* concept and **stays**. Only the commitments *entity* is removed.

Blast radius (categories — verify each before deleting):

| Area | Touch points |
|---|---|
| Schema / migrations | `db/schema.ts` `commitments` table; migrations `0001_init`, `0007_commitments_note`, `0010`; `meta/*_snapshot.json`; `db/migrate-from-mongo.ts` |
| Planner | `goal-planner/schemas.ts` (`PlanCommitmentSchema`, `add_commitment`, `complete_commitment`), `prompts.ts`, `scheduler.ts` (commitments input → daily rows), `orchestrator.ts`, `cross-validator.ts`, `config.ts` |
| Executor / tools | `proposal-executor.ts` (`applyAddCommitment`, `applyCompleteCommitment`), `proposal-tools.ts`, `chat/ops-graph.ts`, `tools/confirm|reject` |
| State | `dashboard-state.ts`, `llm/state-builder.ts`, `drift-service.ts`, `goal-drop.ts`, `replan-suggestions.ts`, `daily-log.ts` (+ its `commitments` JSON snapshot), `audit` export, guest/persona seeding |
| Routes | `app/api/commitments/route.ts`, `app/api/commitments/[id]/route.ts` (delete); callers in `state`, `daily_log`, `timetable`, `motivation`, `goals/[id]`, `chat/*` |
| Frontend | `api.js` (`commitments/createCommitment/updateCommitment`), `Today.jsx`, `TodayTimetable.jsx`, `TrackerCard.js`, `TrackingDashboard.js`, `Timeline.js`, `DayPlanner.jsx`, `CalendarCards/MonthGrid/HourGrid`, `Coach.js`, `WelcomeToast`, `Motivation*`, plus stories/fixtures |
| Tests | ~10 test files assert commitments — update/delete with the code |

**Removal order (safe on a live app):**
1. Stop **reading** (state builder, dashboard, UI) — surfaces disappear.
2. Stop **writing** (planner schema/prompts, executor tool actions, routes) — the table goes stale.
3. Stop **snapshotting** (`daily_log.commitments`, audit export).
4. **Drop** the table + snapshots in a dedicated Drizzle migration (destructive; run last, after 1–3 deploy).
5. Delete the removed tests; keep `over_commitment` tests.

**Guard:** the planner no longer emits `add_commitment`/`complete_commitment`; confirm/reject must reject those action names cleanly during the transition.

---

## 1. Model change · LOCKED

- **Commitments gone** (see §0). Hierarchy: **goal → phases (optional) → milestones → scheduled work (month → week → day)**.
- **Phases optional** — none → the solver treats the goal span as one phase.
- **Priority 1–5** on goals *and* milestones; the solver weights its objective by it and uses it to decide what to relax.

## 2. Architecture

```
intake (LLM, chat)      → classify; if availability unset, ask (MCQ)
  ↓
plan (LLM)              → goal · phases(opt) · milestones(+priority 1-5)   [meaning]
  ↓
schedule (CP-SAT TOOL)   → ONE tool, scope arg, called by the LLM:
                           month allocation → week split → day assignment  [dates]
  ↓
decompose (LLM)         → distinct task content per week/day                 [meaning]
  ↓
validate                → guard LLM + solver; solver fail → deterministic fallback
  ↓
confirm                 → propose → user confirms (unchanged rule)
```

**Boundary (locked):** solver never invents meaning; LLM never owns dates. The solver is a **tool node** the LLM calls (re-callable per level and after events).

## 3. Roles

| Layer | Produces | Does NOT |
|---|---|---|
| LLM — plan | goal, phases (opt), milestones (+ priority 1–5) | dates |
| LLM — schedule call | proposes month/week/day content | final dates |
| CP-SAT — `schedule` tool | month/week/day placement, capacity fit, feasibility | titles, scope |
| LLM — replan | new milestones/scope on intent change | silent writes |
| Validator | rejects malformed/duplicate/over-budget | — |

## 4. Data model

### 4.1 Availability (new)

```
users.availability  jsonb, default {}
  // { "mon": { "hours": 2 }, ..., "sat": { "hours": 4 }, "sun": { "hours": 0 } }
users.available_weekly_hours  integer   // keep — total discretionary budget
```

- **Weekday template** = recurring weekly free time (solver reads this).
- **Date-specific density** ("end of month", a trip) = a **blocker** row (existing, direct-CRUD).
- Deferred: free windows, per-goal availability, recurring rules.

### 4.2 Schedule (existing)

```
plan_items  id, user_id, goal_id, horizon, phase, title, note,
            start_date, end_date, due_date, weekly_hours, status
```

Horizons: `yearly | quarterly | monthly | weekly | daily`. Tool writes dates/spans/placement; LLM writes titles/notes.

### 4.3 Write-bucket decision (Hard constraint #2)

- **Scheduling fields** (dates, placement) → **direct** bucket (like blockers): solver re-lays without confirm.
- **Semantic fields** (titles, scope, goal/milestone text) → **confirm** bucket: coach only.

## 5. Availability capture (chat + Settings)

Asked once when `users.availability` is unset; editable in Settings. Reuses Stage-1 clarify (MCQ, capped rounds).

1. **"Which days can you realistically put time into goals?"** — multi `Mon…Sun`.
2. **"Roughly how much on a weekday / weekend?"** — `<30m · 30–60m · 1–2h · 2–4h · 4h+` → hours/weekday.
3. **"Any recurring periods you're usually slammed?"** — multi `End of month · Mondays · Mornings · Evenings · None`.
4. **"Any dates coming up (trips, deadlines)?"** — free text → blockers.

Stored → `users.availability` + `blockers`. Settings gets a **weekday picker + per-day hours**.

## 6. The `schedule` tool (single tool, `scope` arg) · LOCKED

```
schedule({
  scope,        // "month" | "week" | "day"
  availability, // { dayOfWeek → hours }
  budget,       // available_weekly_hours
  blockers,     // [{ start, end }]
  items,        // [{ id, goal_id, priority(1-5), est_hours, order?, deadline? }]
  targets       // { month?, week?, deadline? }
})
```

**Variables** — `assign[item][slot] ∈ {0,1}` (slot = month | week | day).

**Constraints** — exactly one eligible slot per item (respect availability, avoid blockers) · `Σ hours/day ≤ day cap` · `Σ/week ≤ weekly budget` · `Σ goals ≤ available_weekly_hours` · precedence · deadlines ≤ milestone target.

**Objective (MVP)** — `minimize Σ (priority_weight × lateness)` where higher priority → higher weight (1–5); tie-break front-load.

**Output** — `{ feasible, assignment: [{item_id, slot, date}], slack, ifInfeasible: { minimalRelaxSets } }` (relax sets ranked by priority).

**Deploy** — `or-tools-wasm` CP-SAT (~7 MB, 27 ms init, ~200 ms solve, spike-verified), server-side Node. Fallback on any error → deterministic `buildLattice`.

## 7. Re-plan semantics (soft vs hard)

| Event | Actor | Behaviour | User sees |
|---|---|---|---|
| Daily step slips / swapped | tool | re-solve week | nothing |
| Blocker added | tool | remove windows, re-solve weeks | tasks re-flow |
| "I did xyz instead" (Today free-text) | LLM + tool | record substitute, re-check week | absorbed, silent |
| A week can't fit | tool → coach | minimal drop/shift set (by priority) | "shift/drop?" **confirm** |
| Goal scope/dates change | LLM | replan | propose → **confirm** |

Triggers: write-path mutations (blocker CRUD, plan-item status, new plan, drift); scoped + debounced, off the read path.

## 8. Graph placement

- Stage 1 intake → ask availability when empty.
- Stage 3 plan → goal, phases (opt), milestones (+priority). No commitments.
- `schedule` **tool node** → LLM calls it per level (month → week → day); re-callable after events.
- Decompose (LLM) → distinct content per week/day, bounded by the allocation.
- Validator → zod + semantic; reject → fallback.

## 9. Frontend

Settings → Availability (weekday picker + hours) · Today/Day view shows distinct steps (no commitments) · optional "re-flowed around your trip" change note · Timeline current-period highlight already shipped.

## 10. Sequencing & MVP scope

1. **Slice 0 — remove commitments (app-wide)** (§0). Prerequisite.
2. **Integration spike** — CP-SAT behind the graph; verify the built Next function traces the `.wasm`.
3. **Scheduling MVP** — weekday availability + blockers · availability intake · `schedule` tool for a single goal (month→week→day) · decompose · deterministic fallback · re-solve on blocker add + plan generation.

**Deferred:** free windows · recurring patterns (blockers cover) · per-goal availability · multi-goal optimization objective · re-solve on every tick/swap · managed cloud/sidecar.

## 11. Decisions — ALL RESOLVED

- **A. Commitments:** remove app-wide (§0).
- **B. Granularity:** hours-per-day at MVP (windows deferred).
- **C. Auto-apply ceiling:** silent re-lay on daily/weekly only; milestone-date moves → confirm.
- **D. Availability scope:** global on the user.
- **E. Objective:** priority-weighted lateness (priority 1–5), tie-break front-load.
- **F. Priority:** 1–5.
- **G. Write bucket:** solver-written `plan_items` dates/placement = **direct** scheduling data; titles/scope stay coach-confirmed.
- **H. Tool shape:** one `schedule(scope, …)` tool re-used per level.

Spec is frozen pending build.

## 12. Test plan

- `schedule` tool: precedence, per-day/per-week caps, deadlines, priority weighting, infeasible→minimal-relax.
- decompose validator: rejects duplicate/empty/over-budget; fallback on failure.
- availability intake: asked only when unset; persists.
- re-solve: blocker keeps week feasible → silent; infeasible → suggestion.
- deploy: built function traces the CP-SAT `.wasm`; solve runs post-build.
- commitments removal: no route/schema/tool references remain; `over_commitment` indicator intact.
