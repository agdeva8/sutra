# HLD — Planning & Replanning Agent (v2)

**Status:** proposed — design only, nothing built
**Owner:** main agent
**Target:** `apps/agent` in the `develop_v2` monorepo
**Supersedes:** `memory/HLD-goal-planner.md`, `memory/LLD-goal-planner.md`, `memory/AGENT-IMPROVEMENT-BACKLOG.md` (v1: TS `api/lib/goal-planner/` + its Python port `backend/app/lib/goal_planner/`)
**Grounding:** the v1 implementation was read in full (both the TS original and the Python port) — this doc keeps v1's working ideas and drops its sprawl. LangGraph idioms follow https://docs.langchain.com/.

---

## 1. Why a v2

v1 works. The problem is its shape, not its output.

The Python port alone is ~7,300 lines across 22 modules:

| Module | Lines | What it owns |
|---|---:|---|
| `staleness.py` | 855 | change ledger + count + toast strings |
| `action_intake.py` | 850 | dispatch table: write → blast radius |
| `orchestrator.py` | 820 | the LangGraph pipeline |
| `plan_relay.py` | 505 | re-lay a goal's plan items |
| `horizon_solver.py` | 412 | CP-SAT placement |
| `schemas.py` | 404 | every contract |
| `prompts.py` | 346 | every prompt |
| `proposal.py` | 330 | apply a confirmed proposal |
| `goal_drop.py` | 315 | drop cascade |
| `scheduler.py` | 291 | deterministic lattice |
| `decompose.py` | 280 | weekly → steps |
| `state.py` | 276 | context builder |
| `user_facts.py` | 246 | durable facts |
| `cross_validator.py` | 224 | grounding check |
| `llm.py` | 220 | provider client |
| `schedule.py` | 208 | week-scope CP-SAT |
| `conversation.py` | 192 | history |
| `checkpointer.py` | 156 | AsyncPostgresSaver |
| `util.py` | 132 | date math |
| `headroom.py` | 91 | capacity check |
| `config.py` | 73 | tunables |
| `drift.py` | 59 | slipped milestones |

Three concrete problems:

1. **Two implementations of one idea.** The TS planner and the Python port both exist; every behaviour change is written twice or drifts.
2. **Three entry points for one concept.** A plan is created by the planner graph, re-laid by `plan_relay`, and classified by `action_intake` — each with its own vocabulary for "what moved".
3. **Replanning is a parallel stack.** `action_intake` + `plan_relay` + `staleness` ≈ 2,200 lines that re-derive blast radius, re-lay dates, and narrate changes — work the planner graph already knows how to do, expressed in a second dialect.

**v2 thesis: one graph, one state, one write path.** Planning and replanning are the *same* graph, entered with a different intent and a different payload. The deterministic core is kept and shrunk. Everything that exists only to re-derive what the graph already knows is deleted.

### 1.1 What the current LangChain docs say about this shape

Checked against https://docs.langchain.com/ (Python index). Three findings shaped this design:

1. **This is a workflow, not a free-running agent.** The docs split the two explicitly: "Workflows have predetermined code paths and are designed to operate in a certain order" vs "Agents are dynamic and define their own processes and tool usage." Planning here has a *predetermined* control flow — clarify → plan → place → propose → confirm — with LLM calls inside the nodes. That is the documented workflow model, and the docs' own over-engineering warnings ("Most applications can skip this"; a 4-field state graph labelled "Over-engineered Graph API") argue against a more agentic shape. §6 widens this to let any stage divert to the interrupt, which is worth stating precisely: the *reachable path set stays statically enumerable* because each origin's resume target is a code constant. The model can decide to divert; it can never choose a destination, and it cannot route the graph itself.
2. **There is no `plan-and-execute` page in the current docs.** It survives only as a blog post and stale notebooks; planning as a *product* feature moved into Deep Agents (`TodoListMiddleware` / `write_todos`). The sanctioned LangGraph-level shape for planning is **orchestrator-worker** — which maps onto this problem almost 1:1: an orchestrator breaks the goal into subtasks (here: horizons and steps), a **deterministic conditional edge** dispatches them, and outputs accumulate through a reducer.
3. **There is no documented solver/constrained-optimisation pattern — this is an explicit gap, not an oversight in reading.** What the docs *do* support, and what §8.2 follows: a node is just a function, so a CP-SAT call is a legal node; give it its own node and its own `TimeoutPolicy`; make it the **validator/normalizer, not the generator**; and treat infeasibility as an *LLM-recoverable* error — store it in state and loop back with the violation as feedback, rather than raising.

---

## 2. Goals / non-goals

**Goals**

1. One compiled LangGraph graph that plans *and* replans — no second pipeline.
2. One write path to `plan_items`, replace-on-write, so a stale or duplicated lattice is unrepresentable.
3. The meaning/dates boundary stays locked (§3) — it is v1's best idea and the source of its correctness.
4. Never fail the user's action: every stage degrades, worst case `no_change`.
5. Human-in-the-loop for anything semantic; day-level re-placement applies silently.
6. Every pure module testable with no LLM, no DB, no network installed.
7. **Multi-goal from the start** — one solve across all active goals sharing the user's weekly budget, so contested slots resolve by goal priority instead of by whichever goal happened to be solved first.

**Non-goals**

- Motivation recommendation, general chat ops, vision/attachments — separate agents, out of scope.
- ML drift prediction. Drift stays a rule.
- Cross-goal milestone interleaving — goals share the weekly budget, but their milestone sets stay independent.
- A new UI. v1's locked surfaces hold: exactly **2** — persistent refresh button + transient toaster.
- Rewriting `apps/web`. This agent is headless behind HTTP + SSE.

---

## 3. The one locked boundary

> **The LLM owns meaning. Code owns dates.**

| Owner | Decides |
|---|---|
| LLM | goal title, phases (2–4), milestone titles, weekly step content, prose |
| Code | phase spans, milestone dates, week bands, the 20% buffer, which day each step lands on |

v1 violated this twice and both were bugs: hand-written arithmetic stamped a task on *every* calendar day, and the LLM invented dates outside the horizon window. The rule is not negotiable in v2 — the solver never invents meaning, the LLM never writes a date.

Corollary: **a step whose date the LLM chose is a bug, not a fallback.** If the LLM returns a date field, the schema rejects it.

This also rules out a "quick LLM first pass, solver only if needed" arrangement. A first pass that emits dates is the same bug with an extra step — it is exactly how v1 stamped a task on every calendar day. The LLM contributes *work items and effort estimates*; **every date comes from the solver**, with no exceptions and no fast path.

---

## 4. System context

```
 apps/web (React 19)      apps/api (FastAPI)              apps/agent (library)            Supabase / Postgres
 ───────────────────      ──────────────────              ────────────────────            ───────────────────
 Plan workspace ─plan─▶ POST /plan/run ──in-process──▶ plan_graph ──▶ LLM (structured out)   goals
   refresh button        (run|resume)                   ├─ lattice   (pure, dates)           milestones
   toaster                                              ├─ decompose (LLM, steps)            plan_items
 confirm card ─confirm▶ POST /plan/confirm ─────────────┤─ place     (pure, solver) ─writes▶ blockers
                                                        │                                     proposals
   ◀── SSE: delta | tools |                             └─ checkpointer ────────────────────▶ checkpoints
       needs_clarification |                               (thread_id = conversation_id)     (LangGraph)
       replan{slim|escalate, adjustments[]} | done | error
```

**One HTTP surface.** `apps/web` talks to `apps/api` and to nothing else. The
planner is not exposed: `apps/api` serves `/plan/*` and `/chat/*` by importing
`apps/agent` in-process, so the boundary between them is a function call, not a
network hop. The agent is a library and has no routes of its own.

Two surfaces only, per the locked product contract: the refresh button reads staleness; the toaster renders `adjustments[]` from the `replan` event.

**Stack (locked):** `apps/web` is React (Vite) only. `apps/api` is Python 3.12 + FastAPI — the one HTTP surface the frontend calls. `apps/agent` is a **library** (`core/`, `graph/`, `llm/`, `contracts/`, `prompts/`), imported by `apps/api` in-process. No Next.js in v2.

---

## 5. Module map — `apps/api` (the service) and `apps/agent` (the library)

`apps/api` owns the wire; `apps/agent` owns the planning. Because the agent is
imported in-process, the boundary between them is a function call.

```
apps/api/                       FastAPI — the only surface apps/web calls
  app/
    main.py                     FastAPI app; lifespan opens the checkpointer pool
    config.py                   Settings (pydantic-settings); every tunable
    deps.py                     auth → CurrentUser
    api/
      plan.py                   POST /plan/run, /plan/change, /plan/confirm, /plan/staleness
      stream.py                 SSE adapter over graph.astream(stream_mode="custom")
      …                         the product routes — see apps/api/openapi.yaml
    store/
      repo.py                   goals, milestones, plan_items, blockers, proposals
      checkpointer.py           AsyncPostgresSaver | InMemorySaver

apps/agent/                     library — imported by apps/api; no routes
  app/
    graph/
      build.py                  build_plan_graph(...) -> compiled StateGraph
      state.py                  PlanState (TypedDict) + reducers
      nodes.py                  the 12 nodes, one function each
      routers.py                one per node — at_start, after_intake, after_clarify,
                                …, after_validate — plus the shared `_early`
    core/                       PURE — imports no DB, no network, no LLM client
      util.py                   date math, weekdays, rounding
      lattice.py                build_lattice() — phase spans, milestone dates, bands, buffer
      place.py                  place() — the OR-Tools CP-SAT model, all goals in one call
      fallback.py               structural placement — the only fallback (~15 lines)
      headroom.py               check_headroom()
      validate.py               cross_validate() — grounding, verdict in code
      drift.py                  compute_drift()
      staleness.py              classify_change() + build_adjustments() — pure
    contracts/
      schemas.py                every pydantic model; single source of truth
    prompts/                    one prompt per LLM stage — prose, not shapes
    llm/
      client.py                 complete_json / complete_json_object; one seam
    tui.py                      the terminal UI
```

**Open:** `store/` sits with the service because the pool is opened in its
lifespan (§11), but `repo.py` is read by both the planner and the product routes
(`/state`, `/goals`). Settle the split when slice 4 lands.

**Dependency rule (enforced by a test, not by convention):** `core/` imports nothing from `store/`, `llm/`, `graph/`, or `api/`. `graph/nodes.py` is the only place pure and impure meet.

---

## 6. The graph

```
START
  │
  ▼
n_intake ──────────────(material unknown)──▶ n_clarify ──┐
  │  LLM: shape, material_unknowns,          the ONE      │
  │       change → blast radius              interrupt()  │ resume
  │◀──────────────────────────────────────────────────────┘
  │        (resume lands where the ORIGIN declared — see below)
  │
  ├──(early / conversational)──────────────────────────────▶ END  (kind=early)
  ├──(intake failed)───────────────────────────────────────▶ END  (kind=no_change)
  │
  ▼
n_plan ──(empty plan | LLM failed)─────────────────────────▶ END  (kind=no_change)
  │  LLM: goal, 2–4 phases, 3–8 milestones — MEANING ONLY
  ▼
n_lattice        pure: phase spans, milestone dates, week bands, 20% buffer
  ▼
n_decompose      LLM: weekly row → ≤7 steps, each carrying est_hours, priority,
  │                   depends_on[], session_max_hours   ← the LLM's CONSTRAINT input
  ▼
n_place          pure: ONE CP-SAT solve, every goal → a day per step
  │              THE ONLY WRITER OF plan_items DATES
  ▼
n_verify         pure: hard invariants — capacity, shared budget, windows,
  │                    blocked days, one-sitting-per-task, grounding
  ├──(violated)────────────────────────────────────────────▶ END  (kind=no_change)
  ▼
n_review         LLM: does this placement make SENSE?
  ├──(rejected, rounds < 2)──▶ n_place   with ConstraintDelta[] ← the ONLY way the loop changes
  ├──(rejected, rounds = 2)────────────────────────────────▶ END  (kind=renegotiate)
  ▼
n_headroom       pure: capacity check
  ├──(free < -slack)───────────────────────────────────────▶ END  (kind=renegotiate, ≤2 rounds)
  ▼
n_propose        LLM: one ReplanAction, filtered to the intent's allowed set
  ├──(LLM failed)──────────────────────────────────────────▶ END  (kind=no_change)
  ▼
n_validate       pure: every tool must trace to the plan
  ├──(failed, attempt 1)──▶ n_propose   (retry with the diff)
  ├──(failed, attempt 2)───────────────────────────────────▶ END  (kind=no_change)
  ▼
 END  (kind=ok)
```

**Routers.** Each reads `state["result"]` first: if set, route to `END`. That single rule is what makes "never fail" structural rather than defensive — a node sets `result` and the turn is over, cleanly. The five *origin* routers read one more key before their default, through `_early`: a pending `clarify_request` diverts to the interrupt. Only an origin's own router reads it — `n_clarify` consumes the request in the same turn it was written, so no other router can ever see one, and `at_start` deliberately never looks (it runs against checkpointed state on every new turn, where a request left by a crashed turn would hijack the entry).

**Node count is 12.** v1 had 6 nodes but 3 entry points; v2 has 12 nodes and 1 entry point. `n_verify` and `n_validate` are two entry points into the *same* pure module (`core/validate.py`) — placement invariants before the review, grounding after the proposal. `n_clarify` is the interrupt, `n_replan_done` is the slim replan's exit, and `n_place` is re-entered (not duplicated) on a review rejection.

**Clarify is a hub, not a stage.** Any stage that can find a material unknown — `n_intake`, `n_plan`, `n_decompose`, `n_review`, `n_propose` — writes a `clarify_request` and its router diverts to `n_clarify`. The origin also declares where execution resumes once the answer is in, as a **code constant**: the model chooses *whether* to divert, never *where to*, which is what keeps the reachable path set statically enumerable. An origin's resume target is never downstream of the origin — a question re-derives the plan, then proposes. The pure nodes (`n_lattice`, `n_place`, `n_verify`, `n_headroom`, `n_validate`, `n_replan_done`) cannot originate one: they have no model and no unknown-bearing schema, and a solver invariant violation is a bug, not a missing fact.

**Graph idioms (doc-grounded).**

- **Node granularity is the determinism lever.** The docs list checkpoint granularity, scoping retry policies to external services, intermediate visibility, and testability as the reasons to split nodes — and note "more nodes doesn't mean slower execution" (checkpoints are written in the background). That is why `place`, `headroom`, and `validate` are separate nodes rather than calls inside `n_plan`: each is pure, independently retryable, and independently testable.
- **One `interrupt()` per node invocation, and it lives in exactly one node.** A node may not ask twice, and no stage may call `interrupt()` itself: LangGraph re-executes a node from its first line on resume, so an interrupt placed after a model call would replay that call — and the *second* completion is what the resumed turn would proceed with, while the user answered questions from the first. Every stage therefore routes to `n_clarify`, which does no model or solver work above the `interrupt()` call and resumes at the node the origin declared. Capped at `MAX_CLARIFYING_ROUNDS`, with dedupe on the unknown name as the actual livelock guard.
- **`error_handler=` per node** (langgraph ≥ 1.2) is the sanctioned degradation hook; **`TimeoutPolicy(run_timeout=...)`** bounds `n_place`, whose search is the only unbounded thing in the graph.
- **`Send` for per-horizon fan-out** is available if the solver is ever split per horizon — not needed at slice 1–7, but it is why `items` and `slots` carry reducers.
- **Edge topology is not persisted** in a checkpoint, so edges may be added, removed, or rerouted on a live deployment. Node and state-key *renames* are what break paused threads (§11.1).

---

## 7. State & contracts

```python
class PlanState(TypedDict, total=False):
    # request
    intent: str              # add_goal | plan_day | edit_goal | drop_goal | review_progress | replan
    message: str
    context: str             # LIVE STATE & MEMORY, built by the caller
    today: str
    mode: str                # auto | ask | grill
    # intake
    intake: dict | None
    clarify_rounds: int
    clarify_answers: list[dict]  # every answer this turn, folded into `context`
    clarify_request: dict | None # inbox: {origin, resume, prompt, questions, reason}
    clarify_resume: str | None   # outbox: where `after_clarify` lands
    clarify_asked: list[str]     # unknown names asked this turn — the livelock guard
    # planning
    plan: dict | None
    lattice: dict | None
    items: list[dict]        # PlanItemRow[]
    slots: list[dict]        # solver output
    deltas: list[dict]       # ConstraintDelta[] — accumulated solver input from review
    critique: dict | None    # PlacementCritique from the last n_review
    review_rounds: int
    headroom: dict | None
    # replan
    change: dict | None      # {kind, horizons_moved, milestone_moved, goal_id}
    tier: str | None         # slim | escalate
    adjustments: list[str]
    # propose / validate
    proposals: list[dict]
    cv_errors: list[str]
    attempts: int
    # bookkeeping — concatenating reducers accumulate across nodes AND resumes
    rejects: Annotated[list[dict], operator.add]
    result: dict | None
```

**Two state rules, both learned the hard way in v1:**

- **Store raw data, not formatted text.** The docs are explicit: "your state should store raw data, not formatted text. Format prompts inside nodes when you need them." v1 stored pre-built context strings; v2 stores `plan`, `items`, `slots` as data and formats prompts in the node that needs them. This is also what makes the state checkpoint small and diffable.
- **Resetting a merging reducer needs `Overwrite`, not `[]`.** Returning `[]` to an `Annotated[list, add]` key does **not** clear it — the empty value is merged, so the old entries survive. To replace a plan wholesale (the replan case) the node must return `{"items": Overwrite([])}`. v1 worked around this by deleting the whole thread's checkpoints before a fresh run (`clear_plan_thread`), which also threw away the resume history; `Overwrite` is the correct mechanism and v2 uses it.

**Schema evolution is a compatibility contract.** LangGraph always runs the newest deployed graph against previously persisted state — "every change you ship is effectively a backward-compatible API change with respect to your existing checkpoints." So: new state keys are added as `NotRequired` / `Optional[...] = None`, removals are treated as deprecations, node functions tolerate unknown keys, and a paused thread is never left at a node that has been renamed or removed. See §11.1.

**Contracts (pydantic, one file).** `IntakeSpec`, `ClarifyQuestion`, `PlanSpec`, `GoalSpec`, `MilestoneSpec`, `DecomposeSpec`, `DecomposeStep`, `ReplanAction`, `PlanItemRow`, `Change`, `Verdict`, `PlacementCritique`, `ConstraintDelta`.

**Two bases, because two different things are being validated.** `_Strict`
(`extra="forbid"`) covers models *we* construct and the solver's I/O — an
unexpected key there is our own bug. `_Llm` (`extra="ignore"`) covers models the
*model* fills. A real model volunteers fields it was never asked for, and
rejecting the whole response over an unrequested extra is a reliability bug, not
rigour. This was not theoretical: the first real DeepSeek run returned
`material_unknowns` as `{"key": …, "reason": …}` dicts, omitted every question
`id`, and added `confidence` / `can_plan` / `reason` / `known` / `next_action` /
`plan_emitted`. That was 23 validation errors, and the agent could not plan at
all. The graph degraded correctly — `no_change` with an `[intake]` reject row,
which is the reliability contract working — but a contract that can never be
satisfied by a real model is not a contract, it is a wall.

So `_Llm` absorbs the shape, and the §3 guarantee is re-expressed as a *key*
check rather than a whole-object rejection: `_no_dates = True` on
`DecomposeStep` and `MilestoneSpec` rejects a date-shaped key (`date`,
`start_date`, `due_date`, `target_date`, `scheduled_for`, …) while ignoring
everything else. Tolerant of invention, intolerant of the one thing that would
break the single-writer invariant.

Two further consequences, both deliberate:

- **The prompt carries the real schema.** `schema_brief()` compacts
  `model_json_schema()` and injects it into the system prompt. The model was
  inventing field names because it had never been shown the real ones; the
  contract was right and the prompt was silent. A failed parse gets one repair
  round-trip carrying the validation error back.
- **A bare rejection is coerced, not honoured.** `PlacementCritique` with
  `ok=False` and no deltas becomes `ok=True`. This is not leniency — it is
  §8.6 applied literally: a rejection with no structural delta *cannot change
  the solver's answer*, so treating it as a rejection spins the loop to its cap
  and then surfaces `renegotiate` for no reason. Same logic makes
  `IntakeSpec` synthesise a question for an unknown the model listed but forgot
  to ask about, rather than failing the turn: the invariant is "we must ask",
  and asking satisfies it.

**One tool action, intent-discriminated** (locked). v1 had nine (`create_goal, update_goal, drop_goal, pause_goal, set_goal_dates, add_milestone, add_blocker, add_commitment, complete_commitment`), each with its own arg schema, its own executor branch, and its own cross-validation rule — which is where the append-duplicate and orphan-row bugs came from (v1 backlog 6.2, 6.3). v2 emits one action:

```python
class ReplanAction(BaseModel):
    intent: Intent          # add_goal | edit_goal | drop_goal | pause_goal | plan_day | review_progress
    goal_id: str | None
    changes: PlanChanges    # the SEMANTIC delta: title, dates, weekly_hours, milestones[]
    rationale: str
```

`PlanChanges` carries no dates for tasks — the solver owns those (§3). One action means one executor, one validation rule, one audit shape. The nine collapse further because three of them (`add_milestone`, `add_commitment`, `complete_commitment`) were overlapping names for the same thing under v1's retired terminology; `add_blocker` leaves the tool surface entirely, since blockers are direct CRUD by product rule.

Two vocabularies that v1 conflated and v2 keeps distinct:

- **Goal size** — `HORIZONS = [weekly, short, medium, long]`, with windows (`short` = 30–90d). Sizes a goal.
- **Lattice grain** — `PLAN_HORIZONS = [daily, weekly, monthly, quarterly, yearly]`. The `plan_items.horizon` enum.

**Locked terminology** (from the v1 backlog §0, not to be regressed): Goal · Milestone (overlay chip, never a plan level) · Year/Quarterly/Monthly/Weekly Plan · Daily Task · Time Block · **slim replan** (day-level, automatic, toaster) · **full replan** (week-or-higher, confirm modal).

---

## 8. Deterministic core

### 8.1 `build_lattice` — structure

Pure. Owns phase spans, milestone dates, week bands, the 20% buffer.

```
total = days(start, target);  if total < 7 → target = start + 7
spans[i] = [start + round(i·total/n), start + round((i+1)·total/n)]     # n = phases
win_end(span) = span.start + (1 - 0.2) · span_len                      # 80% window
milestone j in span: target = min(span.start + round((j+1)·seg), span.end)
                     work_start = span.start + round(j·seg·0.5)        # parallel tracks
weekly bands step 7 from span.start to win_end;
  label = active.count > 1 ? f"{title} — part {i}/{N}" : title
emit quarterly (per span) and yearly (per goal span)
```

Output `items[]` ordered yearly → quarterly → monthly → weekly → daily, plus `spans[]` for the UI.

### 8.2 `place` — placement (OR-Tools CP-SAT)

**One call, one model, every goal.** OR-Tools CP-SAT is the solver — not an escalation behind a hand-written algorithm. It is the right tool because the problem *is* a constraint program: assign each work item to a day, under per-day capacity, a shared weekly budget, availability, blockers, and priority, maximising weighted coverage. A hand-written greedy cannot express the shared-budget allocation globally; CP-SAT does it natively.

```python
def place(items, availability, blocked_dates, *, today) -> PlaceResult
```

v1 proved the shape (`horizon_solver.py`, 412 lines, shipped and tested). v2 keeps the model and adds one constraint family — the shared weekly cap (§8.3).

**`place` is a validator/normalizer, not a generator.** The LLM never hands it dates — it hands it *work items*, and `place` is the only thing that produces a date (§3). When the plan is infeasible against real availability, the violation goes back into state and the graph loops rather than raising — the doc-recommended evaluator-optimizer posture applied to a solver.

```python
graph.add_node("n_place", n_place, timeout=TimeoutPolicy(run_timeout=10.0))
```

`n_place` is the only node with a timeout — the search is the only unbounded work in the graph. Everything else is a bounded LLM call or pure arithmetic. The model runs `numWorkers=1`: a plan must be reproducible, and a deterministic solver is worth more than a fast one.

### 8.3 The model — multi-goal, one shared budget

Multi-goal is in scope from slice 1. `place` is **not** called per goal; one model covers every active goal, so contested slots resolve globally instead of by whichever goal was solved first.

```
D       = ⋃ window(t)                        # candidate days, all goals
cap[d]  = blocked(d) ? 0 : availability[weekday(d)]
budget  = users.available_weekly_hours       # SHARED across goals
need[t] = max(1, round(est_hours(t) · 10))   # tenths of an hour — integer, no float drift
smax[t] = session_max_hours(t) ? round(it·10) : need[t]   # per-SITTING ceiling

vars    h[t][d] ∈ 0..min(need[t], smax[t], cap[d])   # tenths placed on day d
        u[t][d] ∈ {0,1}                              # h > 0 ⇔ u = 1
constr  Σ_d h[t][d] ≤ need[t]                          # never more than estimated
        Σ_t h[t][d] ≤ cap[d]                     ∀d    # per-day capacity
        Σ_{t,d : week(d)=w} h[t][d] ≤ budget     ∀w    # SHARED weekly cap ← new
        h[t][d] ≤ min(need[t], smax[t]) · u[t][d]      # per-sitting cap
obj     max Σ (goal_prio(t)·100 + task_prio(t)·10) · h[t][d]
          − Σ days_from_window_start(d) · h[t][d]      # tie-break: front-load
solve   CpSat.solve(m, numWorkers=1)
```

**A task may span several days.** This is not a detail — it is the difference
between a working planner and a broken one. Under an earlier one-sitting-per-task
formulation, a 2.7h step against a 2h/day availability could *never* be placed:
no day had room for it, so it fell through to the fallback. A measured run put
**24 of 36 steps** on the fallback. The integer `h[t][d]` model splits that step
into 2h on one day and 0.7h on the next, and the same run places **36 of 36**.
`session_max_hours` therefore caps a single *sitting*, which is what it always
meant.

Four things this buys that v1 lacked or did badly:

- **The shared weekly cap.** v1 could hold four 10h/week goals against a 40h budget with no objection, because headroom was checked once at creation and the solver only ever saw one goal. The `∀w` constraint is the fix — and it is why multi-goal has to be in the first slice rather than bolted on later.
- **Goal priority outranks task priority.** Contested hours go to the higher-priority goal (`goal_prio` weighted 10× `task_prio`).
- **Bounded horizon.** Placement is confined to each goal's own active window — never an infinite future.
- **Reproducibility.** Integer tenths-of-an-hour plus `numWorkers=1` means the same input yields the same plan.

Returns `{feasible, slots[{task_id, date, hours}], unscheduled[], short[], solver}`.
`unscheduled` is a task that got no hours at all (kept at its window start);
`short` is one that got some but fewer than its estimate. Neither is dropped.

### 8.4 The fallback — structural, not a second algorithm

CP-SAT is a compiled dependency. It can fail to import, time out, or return no solution — and the reliability contract says none of that may reach the user. So `place` keeps exactly one fallback, and it is deliberately dumb:

> **Structural placement** — every unscheduled item keeps its `window_start`. No search, no heuristics, ~15 lines.

**There is no hand-written greedy.** v1 had one; it is not carried over. It is a second placement algorithm to maintain, test, and keep consistent with the model's objective, and it exists only for a path that should be rare. Structural placement is worse but *obviously* correct, which is what a fallback should be.

A step is never dropped either way — unscheduled steps are kept and marked `(over capacity)`, so no work vanishes and the user sees the shortfall rather than a silently short plan.

### 8.5 `check_headroom` / `cross_validate` / `compute_drift`

Pure, unchanged in spirit from v1. The rule that matters: **the verdict is computed in code, never by the LLM.** `cross_validate` proves each proposed tool traces to the plan or to an existing goal; a mismatch is a retry with the diff, then `no_change`.

### 8.6 Verification — two layers, and the determinism trap

The solver is a *feasibility* engine, not a *sanity* engine. It can satisfy every constraint and still be wrong: the final mock interview on day one, a deep-work block inside the user's busiest week, a step placed before its prerequisite. No constraint set and no objective function encode "this reads wrong". So placement is verified twice.

**Layer 1 — `n_verify` (code, deterministic).** Hard invariants. A violation means the solver is buggy or the fallback ran, so the turn ends `no_change` rather than shipping a bad plan:

- per-day capacity never exceeded
- the shared weekly budget never exceeded, summed across all goals
- no task given more hours than it estimated (`Σ_d h[t][d] ≤ need[t]`) — a task
  *may* span several days, so the invariant is on total hours, not on sittings
- every slot inside its task's window; no slot on a blocked day
- every scheduled task traces to a plan item

This is not the LLM's job — it is arithmetic, it is cheap, and a failure here is a bug to fix, not a plan to renegotiate.

**Layer 2 — `n_review` (LLM, semantic).** The judgment calls: sequencing (mocks after learning, not before), load distribution (don't put a hard week's work into the week the user already flagged as busy), rhythm (honour a stated "no deep work on weekdays"), and whether front-loading produced something absurd. The model sees the placement *as the user would* — goals, steps, dates, availability, blockers — and returns a verdict plus, on rejection, constraint deltas.

**The determinism trap — why the critique must be constraints, not prose.**

> CP-SAT is deterministic. Re-running `n_place` with the same input returns the **identical** plan.

A naive "LLM says it's wrong → run the solver again" loop cannot terminate; it spins on the same answer until the round cap. The review's output must therefore *change the model's input*:

```python
class PlacementCritique(BaseModel):
    ok: bool
    deltas: list[ConstraintDelta]   # required when ok is False
    rationale: str                  # for the reject log — never fed to the solver

class ConstraintDelta(BaseModel):
    kind: Literal[
        "precedence",     # task A must land before task B
        "allowed_days",   # restrict a task to certain weekdays
        "avoid_week",     # keep this task out of ISO week w
        "spread",         # minimum days between sittings of one task
        "session_max",    # cap hours in a single sitting
        "pin",            # force a task onto a date
        "priority_bump",  # raise a task's weight in the objective
    ]
    task_id: str
    other: str | None = None
    value: str | int | list[int] | None = None
```

Every one is expressible as a CP-SAT constraint, which is what keeps the boundary intact: **the LLM still never writes a date.** It adjusts the constraint set; the solver re-solves and remains the only thing that produces a date. `deltas` accumulate in `state` across rounds, so round 2 sees round 1's constraints and the loop converges instead of oscillating. Capped at `MAX_REVIEW_ROUNDS = 2`; exhausting it is `renegotiate` — the plan is feasible but the model could not make it *sensible*, which is a real signal to surface rather than paper over.

This is the same evaluator-optimizer shape the docs describe, with one addition the docs don't cover: when the evaluator's "optimizer" is a **deterministic solver**, feedback has to be structural (constraints) rather than textual, or the loop is a no-op.

**What the solver does not decide: time of day.** The decision variable is a *day*, so "midnight" is not reachable — no clock time is produced anywhere in this model. *When* inside a day is the **Time Block** rung, a separate concern needing a time-window availability model (not just hours per weekday), and it is out of scope here. If a user's availability is "Tue 9–11pm", the solver correctly places a 2h task on Tuesday and says nothing about the hour; the Time Block layer owns that.

---

## 9. Replan — the same graph, a different door

This is where v2 earns its keep. v1 spent ~2,200 lines on a parallel stack. v2 spends **one state field and one router**.

### 9.1 Entry

```http
POST /plan/change
{ "action": "blocker.add", "goal_id": "...", "before": {...}, "after": {...} }
```

The caller (any write route) fires this *after* its own transaction and never waits on it — a relay failure must not fail the user's write.

### 9.2 Blast radius → tier

`classify_change` is pure and takes the blast radius as an **argument** — the caller derives it (or `n_intake` does, from a lattice diff), so the module stays testable with no DB.

| Blast radius | Tier | Behaviour |
|---|---|---|
| daily only | **slim** | `place` re-runs; day-level dates rewrite silently; toaster narrates `adjustments[]` |
| weekly or higher, or a milestone moved | **escalate** | minimal day-only changes apply immediately; the rest becomes proposals held for the confirm modal |

Locked write buckets: **scheduling fields are auto** (solver-written), **semantic fields are confirm** (user-written). A user can reject the modal and still use the refresh button.

### 9.3 Staleness — 3 columns, not 855 lines

v1 built an append-only ledger with generations, a baseline store, and a rollup. v2 derives the same number:

- `goals.last_planned_at` — advanced on every **confirmed** plan write.
- `goals.plan_generation` — integer, incremented on confirm.
- `plan_changes(goal_id, generation, kind, horizons_moved, created_at)` — append-only.

Count = changes whose `generation == goals.plan_generation` and `created_at > last_planned_at`. Generation, not timestamp, is what makes the count monotonic inside a window and exactly zero after a confirm. `build_adjustments` renders the toaster strings deterministically — same ledger, same sentence order, so a re-render cannot reshuffle the toast under the user's eyes.

### 9.4 One invariant

> **Replace-on-write.** Every write to `plan_items` for a goal is `DELETE ... WHERE goal_id = ?` + `INSERT` inside one transaction — and in graph state, the same rule via `Overwrite` (§7).

v1 needed a whole backlog slice (6.2, 6.3, 7) to chase append-duplicate and orphan rows across four code paths. v2 makes the bug unrepresentable by having exactly one writer.

### 9.5 Open: how specific is the toaster?

The count is fully served by the three columns — it is arithmetic over rows in the current generation. The open question is only about the **sentence**. Three options, in increasing cost:

| | Stores | Renders | Example |
|---|---|---|---|
| **A** (as written) | `kind`, `horizons_moved` | fixed template per `kind` | "Adjusting 3 day tasks around a new blocker." |
| **B** (recommended) | A + `detail jsonb` | fixed template per `kind`, with values substituted | "Adjusting 3 day tasks around your **Goa trip** (Oct 12–18)." |
| **C** (v1's ledger) | arbitrary metadata, arbitrary rendering | anything | — |

**A** is cheapest and fully deterministic, but the toaster can only say *what class* of thing changed, never *which* thing. **C** is what grew to 855 lines in v1, and it drifts: the same change kind can render differently depending on what metadata a route happened to attach.

**B** is the middle: the route supplies the specific values it already has (`blocker` title and dates, goal title, milestone title) into a `detail` jsonb column, and the *template* stays fixed per `kind`. Output remains deterministic because the sentence structure is code, not data — only the noun phrases vary. This is roughly 30 extra lines over A and buys the sentence the product actually wants: the founder's own D8 says the toast should list "adjusting this, adjusting that".

**Recommendation: B.** It is the difference between "Adjusting day tasks" and "Adjusting 3 day tasks around your Goa trip".

---

## 10. Human-in-the-loop

Two interrupts, both real LangGraph, both durable across HTTP requests:

1. **Clarify** — `interrupt({kind: "clarify", questions: [...]})` inside `n_clarify`. The checkpointer persists; the next request resumes with `Command(resume=answers)`. `MAX_CLARIFYING_ROUNDS = 3`.
   **Reachable from any stage that finds a material unknown** — `n_intake`, `n_plan`, `n_decompose`, `n_review`, `n_propose`. A stage writes a `clarify_request` rather than calling `interrupt()` itself (LangGraph re-executes a node on resume, so an interrupt after a model call would replay it), and it declares where execution resumes as a **code constant**. Neither `origin` nor `resume` is a model output: the model may divert, never choose a destination.
   **Invariant (v1 backlog §3, carried over):** the interrupt is **mandatory** when a stage reports a material unknown. The model cannot forget to ask — `_MayClarify` synthesises the question, and `_clarify_request` refuses to plan around the unknown. A material unknown is a core fact without which the plan would be a guess — target role/domain, hours available, deadline. v1 shipped a bug where "I want to change the job" assumed software engineering; the forcing rule is the fix, and it now lives in one gate (`_clarify_request`) rather than a router gate and a node gate that can drift apart.
   **Dedupe, not the budget, is the livelock guard.** `clarify_asked` records the unknown names already asked this turn, so a resumed stage that re-detects the unknown it was just answered on does not re-ask it. `clarify_rounds` is the backstop on the user's patience, shared across stages — using it as the livelock guard would mean a legitimate question is refused because an earlier one was repeated.

2. **Confirm** — semantic proposals persist as `proposals` rows; `POST /plan/confirm` applies one, atomically flipping status and applying in a single step (v1's 6.1 double-apply race is designed out here, not patched).

`thread_id = conversation_id`, so a paused plan survives a reload, a deploy, and a different server process.

---

## 11. Persistence

| Store | Holds | Notes |
|---|---|---|
| `checkpoints` (LangGraph `AsyncPostgresSaver`) | graph state, interrupts | `.setup()` is idempotent, run on lifespan; `InMemorySaver` when `DATABASE_URL` is unset |
| `goals` | the goal | `+ last_planned_at`, `+ plan_generation` |
| `milestones` | outcome checkpoints | overlay chips |
| `plan_items` | **the schedule of record** | all 5 horizons; single writer; replace-on-write |
| `blockers` | date windows removing capacity | direct CRUD |
| `proposals` | pending confirmable actions | |
| `plan_rejects` | per-stage observability | `intent, stage, reason, recovered` |
| `plan_changes` | staleness ledger | generation-scoped |

v1's checkpointer lesson is kept verbatim: **call `.setup()` where the saver is built, not only in the app lifespan** — tests and scripts reach the saver without running lifespan, and an un-setup saver fails on the first read with `relation "checkpoints" does not exist`. Also kept: rebuild the pool when the event loop changes (psycopg's pool binds asyncio primitives to one loop).

### 11.1 Durability and compatibility

- **Durability mode.** `durability="sync"` on the run that writes a plan (persist before the next super-step) so a confirmed plan survives a crash; the default background mode is fine for the read-only stages.
- **Checkpoints grow unbounded.** They must be pruned or given a retention window — the docs call this out as an operational requirement, not an optimisation. `plan-*` threads are safe to drop wholesale; `conversation-*` threads are not.
- **Backward compatibility is a release constraint.** Because the newest graph runs against old checkpoints: never rename or remove a node a thread may be paused at; never rename or remove a state key an old checkpoint holds; never tighten a field (`Optional` → required, narrowed type). Add keys as `NotRequired`. Node functions tolerate unknown keys. When a rename is unavoidable, dual-write through a deprecation window.
- **Business compatibility.** Stamp `flow_version` on state at thread start and branch on it, so a paused thread follows the logic it was paused under. It must be written *before* any branch that reads it.

### 11.2 Long-term memory

Durable *facts* about the user ("I'm a dancer", "works in fintech") do not belong in graph state — state is per-thread and per-run. They belong in a **Store** (`AsyncPostgresStore` in prod, `InMemoryStore` in dev), reached from a node as `runtime.store`, namespaced by user id. This replaces v1's bespoke `user_facts` module (246 lines) with a documented primitive, and gives semantic recall for free via `search(..., query=)` when an embedding index is configured. Store results truncate silently at `limit` — paginate rather than assuming completeness.

---

## 12. Streaming

`graph.astream(..., stream_mode=["updates", "custom"], version="v2")`, nodes emit with `get_stream_writer()`. Wire format unchanged from v1 so `apps/web` needs no rewrite:

```
data: {"type":"delta",              "text":"..."}
data: {"type":"tools",              "proposals":[...]}
data: {"type":"needs_clarification","questions":[...]}
data: {"type":"replan",             "tier":"slim|escalate", "adjustments":["..."]}
data: {"type":"done",               "kind":"ok|early|no_change|renegotiate|clarify"}
data: {"type":"error",              "message":"..."}
```

Only prose goes through `delta`; the tool block is suppressed from the stream (v1's rule, kept).

**API notes.** `version="v2"` normalizes every chunk to `{"type", "ns", "data"}` and is what makes multi-mode streaming readable; without it the chunk shape varies by flag combination. `ns` is the namespace tuple — root is `()`, a subgraph is `("node:<task_id>",)`, and streaming into a subgraph needs `subgraphs=True`. For the server side the docs' newer recommendation is **event streaming** (`graph.astream_events(..., version="v3")`), which exposes typed projections — `stream.messages`, `stream.values`, `stream.interrupts`, `stream.output` — that can be read concurrently without consuming one another. That is the better fit for the SSE adapter here: the `needs_clarification` event comes from `stream.interrupts` rather than being reconstructed from custom writes, and ordering is taken from the strictly increasing `seq` field rather than from timestamps, which drift. Use `stream_mode="custom"` for domain progress; use event streaming for the interrupt and final-output plumbing.

On Python < 3.11, `get_stream_writer()` does not work from async nodes — declare a `writer: StreamWriter` parameter and let LangGraph inject it.

---

## 13. Failure ladder

The safety contract, restated because it is the product's reliability promise:

| Failure | Result |
|---|---|
| intake LLM error | `no_change` + `plan_rejects` row |
| clarify unanswered | `clarify` (state durable, resumable) |
| plan LLM error / empty plan | `no_change` |
| lattice failure | **non-fatal** — continue with raw items |
| solver infeasible / import error / timeout | structural placement; never drop a step |
| `n_verify` invariant violated | `no_change` — a solver bug, not a user-facing failure |
| `n_review` rejects, rounds < 2 | loop `n_place` with `ConstraintDelta[]` — the only way the input changes |
| `n_review` rejects, rounds = 2 | `renegotiate` — feasible but not sensible |
| headroom over budget | `renegotiate`, ≤2 rounds, then `no_change` |
| propose LLM error | `no_change` |
| validate fails twice | `no_change` |

**No model or solver failure ever 500s.** Only programmer errors propagate. This is what makes the pipeline safe to fire from a write route.

Each row above maps to one of the docs' four error strategies — which is how the ladder stays principled rather than defensive:

| Error class | Doc strategy | Where it applies here |
|---|---|---|
| Transient (network, rate limit) | retry policy on the node | `n_intake`, `n_plan`, `n_propose` LLM calls |
| LLM-recoverable (parse, grounding) | store error in state, loop back | `n_validate` → `n_propose` retry with the diff; solver infeasibility → renegotiate |
| User-fixable | pause with `interrupt()` | any of five stages → `n_clarify`; the confirm modal |
| Recoverable after retries | `error_handler=` (langgraph ≥ 1.2) | `n_place` → degrade to structural placement |
| Unexpected | "let them bubble up for debugging" | genuine bugs — never swallowed |

The last row is deliberate and matches v1's contract: the graph catches *what it can handle*, and a programmer error still surfaces loudly.

---

## 14. Non-functional

- **Determinism** — every `core/` function is pure: identical input ⇒ identical output. Enforced by a test that imports `core/` with no DB driver, no HTTP client, and no LLM SDK installed.
- **Idempotency** — replace-on-write plus a proposal-status guard means a retried confirm cannot double-apply.
- **Latency budget** — 4 LLM calls on the happy path (intake, plan, decompose, propose) + 1 more for the placement review, +1 per extra review round (cap 2). `place` is CPU-bound and offline: **one** CP-SAT call over every active goal, `numWorkers=1`, target < 1s for a 5-goal plan, hard-bounded by the 10s node timeout. A timeout degrades to structural placement (§8.4), never to an error.
- **Cost** — one `MAX_TOOLS = 16` cap, one plan-wide solve (v1's win over per-week solves).
- **Observability** — `plan_rejects` per stage makes reject rate measurable per stage, so stages tune independently.
- **Degradation** — the planner is flag-gated (`goal_planner_enabled`, `goal_planner_allowlist`), so it can be dark-launched per user.

---

## 15. Testing

The DI seam that made v1 testable is the single most important thing to keep: **`complete` is injected**, never imported by the node.

```python
run_plan_pipeline(..., deps={"complete": fake_complete})
```

The docs' version of this seam is `context_schema` — compile the graph with a context type and inject the model, clock, and store through `runtime.context`, so tests swap them without touching node code. v2 uses `context_schema` as the primary mechanism and keeps the plain `deps` dict as the seam for pure-function tests that never build a graph.

| Layer | Test |
|---|---|
| `core/` | unit; property tests on `place` — never exceed capacity, every task either placed or explicitly unscheduled, deterministic for a fixed seed |
| `contracts/` | schema round-trip; reject an LLM-supplied date |
| graph | node-level with a fake `complete`; full-graph golden runs per intent |
| HITL | pause → persist → resume across two separate calls; assert the mandatory-clarify invariant from any origin, resuming where the origin declared |
| replan | slim vs escalate table-driven over blast radii; assert count is 0 after confirm and monotonic inside a window |
| store | replace-on-write leaves no duplicates after N consecutive replans |

`pytest` default is `tests/unit` — integration tests hit the shared Supabase, so they stay opt-in.

---

## 16. What we cut, and what it costs

| v1 | v2 | Cost |
|---|---|---|
| `action_intake.py` (850) dispatch table | `n_intake` + one `Change` schema | none — the graph already classifies |
| `staleness.py` (855) ledger + rollup | 3 columns + one ledger table (+ `detail jsonb` if §9.5 lands on B) | loses arbitrary per-change metadata; keeps the count and the sentence templates |
| `plan_relay.py` (505) | `n_place` + replace-on-write | none |
| `proposal.py` (330), 9 actions | one `apply_replan()` (§7) | loses per-action special cases — that is the point |
| `schedule.py` (208) week-scope CP-SAT | folded into `place()` | loses week-scope scheduling (used only by a dev spike) |
| `horizon_solver.py`'s greedy fallback | `fallback.py` structural placement | worse placement on the rare degraded path, in exchange for one less algorithm to maintain |
| `user_facts.py` (246) | `AsyncPostgresStore` (§11.2) | none — a documented primitive replaces bespoke code |
| TS planner + Python port | Python only | one-time migration; ends double-writes |
| ops graph + motivation graph | out of scope here | unchanged, they live elsewhere |

**Added, not cut:** multi-goal shared-budget placement (§8.3) is new work v1 never shipped, and the CP-SAT model itself (`horizon_solver.py`, 412 lines) is *carried over*, not cut — it is now the primary solver from slice 1.

Net: **~7,300 lines → an estimated ~2,800**, with the wedge (cross-horizon synthesis, headroom, renegotiation, HITL) intact. The saving is concentrated in the replan stack and the executor, not in the solver.

---

## 17. Build order

Each slice is independently shippable and testable.

| # | Slice | Deliverable |
|---|---|---|
| 0 | Scaffold `apps/agent` | FastAPI, settings, DI seam for `complete`, `pytest` wired |
| 1 | **Pure core** | `util`, `lattice`, `place` (CP-SAT, multi-goal, shared weekly budget), `validate` (invariants), `headroom`, `staleness` + tests. No LLM, no DB. |
| 2 | Contracts | `schemas.py` (incl. `ConstraintDelta`), `prompts.py`, schema tests |
| 3 | Graph, headless | 12 nodes incl. `n_verify` + the `n_review` loop, fake `complete`, golden runs. No DB, no HITL. |
| 4 | Persistence | checkpointer, `repo`, replace-on-write, `POST /plan/run` |
| 5 | HITL | clarify interrupt + resume from any stage; confirm; mandatory-clarify invariant |
| 6 | **Replan** | `POST /plan/change`, blast radius → tier, `adjustments[]`, staleness count |
| 7 | Solver hardening | timeout → structural fallback; property tests on the model; multi-goal contention and infeasibility cases |
| 8 | Streaming | SSE adapter + `apps/web` wiring |

Slices 1–3 are the whole design. If 1–3 are right, 4–8 are plumbing.

---

## 18. Locked decisions

1. **Stack — locked.** `apps/web` is **React (Vite) only**; `apps/api` is **Python 3.12 + FastAPI** and is the **only** HTTP surface the frontend calls. `apps/agent` is a **library** — Python 3.12 + LangGraph — imported by `apps/api` in-process, with no routes of its own. **No Next.js in v2** — v1's Next.js App Router API layer is not carried over.
2. **Solver — locked: OR-Tools CP-SAT from slice 1.** One model, one call, every active goal. No hand-written greedy; the only fallback is structural placement (§8.4). v1's `horizon_solver.py` is the proven base to port.
3. **Tool surface — locked: one action, intent-discriminated** (delegated here). `ReplanAction` (§7) replaces v1's nine.
4. **Multi-goal — locked: in scope from slice 1** — and it is what forces CP-SAT into slice 1 as well, because the shared weekly cap is a global constraint no greedy expresses cleanly (§8.3).
5. **Placement verification — in scope.** Two layers: code invariants (`n_verify`) and an LLM semantic review (`n_review`) that loops back with structured `ConstraintDelta[]` (§8.6). Time-of-day / Time Blocks are explicitly out of scope.
5. **Package boundaries — locked: LLM access lives inside `apps/agent`.** `app/llm/client.py` is the only LLM seam, written so it can be lifted into `packages/llm` later without touching node code. No shared package yet — v2 has one consumer, not a platform.
6. **Staleness metadata — settled at implementation: option B** (`detail jsonb` + fixed templates), per §9.5. `build_adjustments` emits one fixed sentence per change kind; the count is generation-based, not timestamp-based.

---

## 18.1 Implemented, and what that changed

Slices 1–3 and 6 are built and green (73 offline tests, no network, no DB). Three
things the build settled that the design left open, all recorded where they
belong above rather than here: the **two contract bases** (§7), the **schema in
the prompt** (§7), and the **date-key check replacing whole-object `forbid`**
(§3, §7). One design claim did not survive contact:

**A task may span several days.** The model was first written one-sitting-per-task,
which the TUI demo disproved immediately — a 2.7h step against a 2h/day cap had
no day with room, so 24 of 36 steps fell through to the fallback. `h[t][d]` is
now an integer in tenths of an hour rather than a boolean, and
`session_max_hours` caps one *sitting* rather than the whole task, which is what
it always meant. Placement went from 24/36 to 36/36. §8.3 reflects the corrected
model.

**The HTTP contract moved to the service, and prompts left `contracts/`.**
`openapi.yaml` — all 47 routes, the whole product — had been sitting in the
agent's `contracts/`. Since `apps/api` is now the one surface `apps/web` calls,
that spec moved to `apps/api/openapi.yaml`, and the agent keeps no HTTP contract
at all: it is a library, and its shapes are `contracts/schemas.py`. Prompt prose
left `contracts/` for `app/prompts/` — it is not a shape.

**Still not built:** `store/`, the FastAPI routes, Postgres checkpointing, and
streaming — slices 4, 5, 8.

---

## 19. References

- LangGraph: [graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) · [persistence](https://docs.langchain.com/oss/python/langgraph/persistence) · [checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) · [stores](https://docs.langchain.com/oss/python/langgraph/stores) · [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) · [fault tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) · [streaming](https://docs.langchain.com/oss/python/langgraph/streaming) · [event streaming](https://docs.langchain.com/oss/python/langgraph/event-streaming) · [subgraphs](https://docs.langchain.com/oss/python/langgraph/use-subgraphs) · [testing](https://docs.langchain.com/oss/python/langgraph/test)
- LangGraph design guidance: [workflows & agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) · [thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph) · [choosing graph vs functional API](https://docs.langchain.com/oss/python/langgraph/choosing-apis) · [backward compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility) · [application structure](https://docs.langchain.com/oss/python/langgraph/application-structure)
- LangChain: [structured output](https://docs.langchain.com/oss/python/langchain/structured-output) · [tools](https://docs.langchain.com/oss/python/langchain/tools) · [human-in-the-loop](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) · [unit testing](https://docs.langchain.com/oss/python/langchain/test/unit-testing)
- Context: [Deep Agents (where planning moved)](https://docs.langchain.com/oss/python/deepagents/overview) · [LangGraph v1 release notes](https://docs.langchain.com/oss/python/releases/langgraph-v1) · [docs index](https://docs.langchain.com/llms.txt)
- Solver: [OR-Tools — CP-SAT](https://developers.google.com/optimization/cp/cp_solver) · [OR-Tools Python install](https://developers.google.com/optimization/install/python) · [scheduling with CP-SAT](https://developers.google.com/optimization/scheduling)
- Planning-agents background (legacy, not current docs): https://www.langchain.com/blog/planning-agents
- v1 design, for the parts kept: `memory/HLD-goal-planner.md`, `memory/LLD-goal-planner.md`, `memory/PRD-goal-planner.md`, `memory/AGENT-IMPROVEMENT-BACKLOG.md` (on `main`)
- v1 code: `api/lib/goal-planner/` (TS), `backend/app/lib/goal_planner/` (Python port, on `feat/python-agent-backend`)
- Locked product contract: `memory/AGENT_BUILDER.md` §0 terminology, two-tier replan D1–D8
