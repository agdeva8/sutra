# PRD — Sutra / GoalCoach v2

**Status:** living document. Describes what exists in `develop_v2` today plus what is
designed and not yet built, marked as such throughout.
**Companion docs:** [`HLD-planning-agent.md`](architecture/HLD-planning-agent.md) (design of
record for the planner), [`AGENT-DESIGN-REVIEW.md`](architecture/AGENT-DESIGN-REVIEW.md)
(verified defects), [`LANGSMITH-PLAN.md`](architecture/LANGSMITH-PLAN.md) (observability and
evals), [`../apps/api/CONTRACT-RECONCILIATION.md`](../apps/api/CONTRACT-RECONCILIATION.md)
(authoritative over `openapi.yaml`).

---

## 1. One paragraph

Sutra is a **planning agent**. It turns one sentence — *"switch jobs in 3 months"* — into a
dated plan spanning five horizons (yearly → quarterly → monthly → weekly → daily), and keeps
that plan true as the user's circumstances change. The distinguishing move is architectural,
not prompt-level: **the LLM owns meaning and code owns dates.** The model writes goal titles,
phases, milestones and steps; a CP-SAT solver places every step on a day. Nothing else in the
product mixes those two responsibilities, and the whole design follows from keeping them apart.

---

## 2. Problem

People carrying several goals across different time horizons experience **narrative debt**.
Each goal sits at the same altitude in their head; switching costs feel zero; days become
buffets of half-attention. The failure is not motivation — it is that no tool holds the whole
multi-horizon picture and re-derives it when reality moves.

The founder is the first user: 28, Bangalore, preparing for interviews in three months while
holding a job, also chasing fitness, sleep, medication adherence, and product work. He has
tried Notion templates, ChatGPT-as-coach, journaling apps and a friend-as-coach. None survived
two weeks. The category's standard failure is the week-2 drop, caused by agents that are
generic, that never adapt, and that know nothing about the rest of the user's life.

**Why existing tools miss.** They are either *trackers* (record what you said you'd do) or
*chatbots* (respond warmly and forget). Sutra's wedge is the combination: a plan that is
specific to this user, adaptive to reality, and whole-life across horizons. Every feature must
serve at least one of those three.

---

## 3. Users

**Primary (v1): the founder, as a real user.** Single-user, dogfooded daily. This is a
deliberate constraint: it keeps the feedback loop honest and makes "would this help me
tomorrow" a usable feature filter.

**Secondary (post-MVP): knowledge workers with a date-bound goal and at least two other live
commitments.** The plan quality bar is "would this survive contact with a busy week".

**Explicitly not the user yet:** teams, managers, coaches-as-operators. There is no
multi-user collaboration surface, and none is planned.

---

## 4. Product principles

| # | Principle | What it rules out |
|---|---|---|
| 1 | **Chat-first, no forms.** One input: *"What's the one thing on your mind right now?"* | Onboarding wizards, goal-creation forms, field-by-field setup |
| 2 | **The plan is the artifact.** Prose explains; the dated plan is the product. | Chatbots that only encourage |
| 3 | **Silence is a feature.** Day-level replans apply without asking. Only semantic change needs a confirm. | Confirm dialogs on everything |
| 4 | **Two UI surfaces, locked.** A persistent refresh (staleness) button and a transient toaster (`adjustments[]`). | Inventing new chrome per feature |
| 5 | **Never fail the user's action.** Every stage degrades; the worst case is `no_change`. | 500s from a model or solver |
| 6 | **Nothing is ever dropped.** An unplaceable step is kept and marked over-capacity. | Silently short plans |

---

## 5. Scope

**In scope (v2):** goal planning; multi-horizon lattice; CP-SAT day placement; clarify
(interrupt) and confirm (modal) HITL; slim and escalated replan; staleness count; the
deterministic supporting surfaces (blockers, timetable, daily log, memories, preferences,
sources, motivation recommendation, audit, dashboard state).

**Out of scope (and why):** time-of-day scheduling (needs a time-window availability model —
the solver's decision variable is a *day*); ML drift prediction (drift stays a rule);
cross-goal milestone interleaving (goals share a weekly budget, milestone sets stay
independent); `/chat/*` (needs a chat graph, see §8.4); PDF/DOCX/OCR extraction; a rewrite of
the frontend.

---

## 6. The agentic system

This is the heart of the product. Sections 6.1–6.12 are the specification of the planner.

### 6.1 The one locked boundary

> **The LLM owns meaning. Code owns dates.**

| Owner | Decides |
|---|---|
| **LLM** | goal title, phases (2–4), milestone titles, weekly step content, effort estimates, dependencies, prose |
| **Code** | phase spans, milestone dates, week bands, the 20% buffer, which day each step lands on |

v1 violated this twice and both were production bugs: hand-written arithmetic stamped a task
on *every* calendar day, and the model invented dates outside the horizon window. The rule is
not negotiable, and three consequences follow from it:

1. **A step whose date the model chose is a bug, not a fallback.** If the model returns a
   date-shaped key, the contract rejects it.
2. **There is no "quick LLM first pass, solver only if needed" path.** A first pass that emits
   dates is the same bug with an extra step.
3. **The LLM's scheduling influence is structural.** When the reviewer wants a change to the
   schedule it emits a `ConstraintDelta`, never a date — it adjusts the solver's *input*, and
   the solver remains the only thing that produces a date. See §6.9.

Enforcement is a **date-key check**, not a whole-object rejection: `_no_dates = True` on
`DecomposeStep` and `MilestoneSpec` rejects a date-shaped key (`date`, `start_date`,
`due_date`, `target_date`, `scheduled_for`, …) while ignoring everything else the model
volunteers.

### 6.2 Shape: a workflow, not a free-running agent

The planner is a **workflow**: predetermined control flow with LLM calls inside the nodes.
This is a deliberate choice, validated against the LangChain/LangGraph design docs — planning
here has a statically enumerable path set, so an agentic (model-routed) shape would buy
nothing and cost auditability.

The reachable path set stays enumerable even though any of five stages may divert to the
clarify interrupt, because **each origin's resume target is a code constant**. The model
decides *whether* to divert; it can never decide *where to*.

What the graph deliberately does **not** have: subagents, multi-agent orchestration, or a
tool-calling loop. The twelve-node graph already *is* the centralized control a supervisor
pattern buys; adding one would add nondeterminism without adding capability.

### 6.3 The graph

**Twelve nodes, one entry point.** Planning and replanning are the same compiled graph, entered
with a different intent.

```
START
  │  at_start: fresh plan → n_intake ; slim replan → n_place
  ▼
n_intake ──────────────(material unknown)──▶ n_clarify ──┐
  │  LLM: intent, shape, material unknowns,     the ONE   │ resume
  │       change → blast radius                 interrupt │
  ├──(early / conversational)────────────────────────────▶ END  (kind=early)
  ├──(intake failed)─────────────────────────────────────▶ END  (kind=no_change)
  ▼
n_plan ──(empty plan | LLM failed)────────────────────────▶ END  (kind=no_change)
  │  LLM: goal, 2–4 phases, 3–8 milestones — MEANING ONLY
  ▼
n_lattice        pure: phase spans, milestone dates, week bands, 20% buffer
  ▼
n_decompose      LLM: weekly row → ≤7 steps, each with est_hours, priority,
  │                   depends_on[], session_max_hours
  ▼
n_place          pure: ONE CP-SAT solve over every goal → a day per step
  │              THE ONLY WRITER OF plan_items DATES
  ▼
n_verify         pure: hard invariants — capacity, shared budget, windows,
  │                    blocked days, grounding
  ├──(violated)──────────────────────────────────────────▶ END  (kind=no_change)
  ▼
n_review         LLM: does this placement make SENSE?
  ├──(rejected, rounds < 2)──▶ n_place  with ConstraintDelta[]  ← the ONLY way input changes
  ├──(rejected, rounds = 2)──────────────────────────────▶ END  (kind=renegotiate)
  ├──(slim replan)───────────────────────────────────────▶ n_replan_done → END
  ▼
n_headroom       pure: capacity check
  ├──(over budget)───────────────────────────────────────▶ END  (kind=renegotiate)
  ▼
n_propose        LLM: one ReplanAction, filtered to the intent's allowed set
  ├──(LLM failed)────────────────────────────────────────▶ END  (kind=no_change)
  ▼
n_validate       pure: every proposal must trace to the plan
  ├──(failed, attempt 1)──▶ n_propose  (retry once with the diff)
  ├──(failed, attempt 2)─────────────────────────────────▶ END  (kind=no_change)
  ▼
 END  (kind=ok)
```

#### Node specifications

| Node | Kind | Input | Output | May clarify |
|---|---|---|---|---|
| `n_intake` | LLM | message, today, existing goals, transcript | `IntakeSpec`: intent, early-exit flag, material unknowns, change + blast radius | **yes** |
| `n_clarify` | interrupt | pending `clarify_request` | `clarify_resume` | is the interrupt |
| `n_plan` | LLM | message, context, existing goal titles | `PlanSpec`: goal, phases, 3–8 milestones | **yes** |
| `n_lattice` | pure | `plan` | `items[]` across all five horizons + `spans[]` | no |
| `n_decompose` | LLM | weekly rows, availability | `DecomposeSpec`: ≤7 steps per row with hours, priority, deps, session cap | **yes** |
| `n_place` | pure (CP-SAT) | tasks, availability, blocked dates, `deltas` | `PlaceResult`: slots, unscheduled, short | no |
| `n_verify` | pure | placement | `verify_errors[]` | no |
| `n_review` | LLM | placement **with meaning** + availability + blockers | `PlacementCritique`: ok, `ConstraintDelta[]`, rationale | **yes** |
| `n_headroom` | pure | capacity vs. goal load | `headroom` | no |
| `n_propose` | LLM | plan, intent, allowed action set | one `ReplanAction` | **yes** |
| `n_validate` | pure | proposals vs. plan | `cv_errors[]` | no |
| `n_replan_done` | pure | slim replan | terminal `ok` with `tier="slim"` | no |

**The pure nodes cannot originate a clarification.** They have no model and no
unknown-bearing schema — and a solver invariant violation is a bug, not a missing fact.

#### Routing rules (two, and only two)

1. **Every router reads `state["result"]` first and routes to `END` if it is set.** A node
   signals "the turn is over" by writing `result`. This is what makes "never fail the user's
   action" **structural rather than defensive** — the turn ends cleanly without each edge
   knowing which failure produced it.
2. **Origin routers read `clarify_request` second, through `_early`.** Only an *origin's*
   router reads it: `n_clarify` consumes the request in the same turn it was written, so no
   other router can ever see one.

`at_start` deliberately skips rule 2 — it runs against checkpointed state on every new turn,
where a request left by a crashed turn would hijack the entry.

### 6.4 State

`PlanState` is a `TypedDict(total=False)` storing **raw data, not formatted text**. Prompts are
formatted in the node that needs them, which keeps checkpoints small and diffable.

Two rules learned the hard way in v1:

- **Returning `[]` does not clear a merging reducer.** For a key annotated
  `Annotated[list, operator.add]`, returning `[]` merges the empty value and the old entries
  survive. Replacing a plan wholesale (the replan case) requires `{"items": Overwrite([])}`.
  This is a *verified live defect* in the current build — see §9.2.
- **New keys are `NotRequired`.** LangGraph always runs the newest deployed graph against
  previously persisted checkpoints, so adding a key is a compatibility promise and a rename is
  a breaking change. Edge topology is *not* persisted, so edges may be rerouted freely.

Key groups: request (`intent`, `message`, `context`, `today`, `mode`, `availability`,
`blocked_dates`, `weekly_budget_hours`) · intake (`intake`, `clarify_rounds`, `clarify_answers`,
`clarify_request`, `clarify_resume`, `clarify_asked`) · planning (`plan`, `lattice`, `tasks`,
`items`, `place`) · verification (`verify_errors`, `deltas`, `critique`, `review_rounds`) ·
capacity (`headroom`, `renegotiation`, `proposals`, `cv_errors`, `attempts`) · replan (`entry`,
`change`, `tier`, `adjustments`) · bookkeeping (`rejects`, `result`).

### 6.5 Contracts at the model boundary

`apps/agent/app/contracts/schemas.py` is the single source of truth for every shape. There are
**two base models and the distinction is load-bearing**:

| Base | Policy | Used for | Why |
|---|---|---|---|
| `_Strict` | `extra="forbid"` | models we construct, solver I/O | an unexpected key is *our* bug |
| `_Llm` | `extra="ignore"` | models the *model* fills | a real model volunteers `confidence`, `reason`, `next_action`, `{"key":…, "reason":…}` where a string was asked for, and omits question `id`s |

The `_Llm` relaxation is not leniency, it is reliability. The first real DeepSeek run produced
**23 validation errors** and the agent could not plan at all. Three things go with it:

1. **The prompt carries the real JSON schema** (`model_json_schema()` via `schema_brief()`,
   compacted). The model invented field names because it had never been seen the real ones.
2. **One repair round-trip** on a failed parse, carrying the validation error back.
3. **Complete the invariant, don't reject the turn.** Two coercions: a `PlacementCritique`
   with `ok=False` and no deltas is coerced to `ok=True` (CP-SAT is deterministic, so a
   rejection with no structural delta cannot change the answer and would only spin the loop to
   its cap); an `IntakeSpec` that lists an unknown but forgets to ask about it **synthesises**
   the question, because the invariant is "we must ask".

**Vocabularies (two that v1 conflated and v2 keeps distinct):**

- `GoalSize = weekly | short | medium | long` — how big a *goal* is. Windows: `weekly` 7–14d,
  `short` 30–90d, `medium` 90–270d, `long` 270–540d.
- `PlanHorizon = daily | weekly | monthly | quarterly | yearly` — the `plan_items.horizon`
  grain, the execution ladder. `HORIZON_RANK` orders them coarsest-last for blast-radius
  ranking.
- `Intent = add_goal | plan_day | edit_goal | drop_goal | review_progress | replan`
- `Tier = slim | escalate`
- `ResultKind = ok | early | no_change | renegotiate | clarify`
- `DeltaKind = precedence | allowed_days | avoid_week | max_per_day | session_max | pin |
  priority_bump`
- `Mode = auto | ask | grill`

**One tool action, intent-discriminated (locked).** v1 had nine actions, each with its own arg
schema, executor branch and cross-validation rule — which is where the append-duplicate and
orphan-row bugs came from. v2 emits exactly one:

```python
class ReplanAction(BaseModel):
    intent: Intent
    goal_id: str | None
    changes: PlanChanges      # the SEMANTIC delta: title, dates, weekly_hours, milestones[]
    rationale: str
```

One action means one executor, one validation rule, one audit shape.

### 6.6 Prompts

Prompts live in `apps/agent/app/prompts/` — prose, not shapes, kept apart from `contracts/` for
the same reason the chat package keeps them apart. One prompt per LLM stage.

Every stage that may ask carries the same **forcing-rule paragraph**, at a bar that rises the
further down the graph it sits: intake asks readily, propose almost never. The paragraph is not
what enforces asking — the validator is — but a stage that has never been told it may ask will
simply plan around what it does not know.

The base persona is explicit about register: *"Be precise and curious. Not warm, not
motivational."* Milestones are OUTCOME checkpoints observable from outside ("Pass 5 SD mocks",
not "make progress on SD"). Phases are named stages that read as a trajectory
("Foundations → Mocks → Full loops"), never calendar words.

### 6.7 Human-in-the-loop — clarify, the one interrupt

**Clarify is a hub, not a stage.** Any of five stages that finds a material unknown writes a
`clarify_request` and its router diverts to `n_clarify`. No stage calls `interrupt()` itself.

That rule is not stylistic. **LangGraph re-executes a node from its first line on resume**, so
an interrupt placed after a model call would replay that call — and worse than paying twice,
the *second* completion is what the resumed turn would proceed with, while the user answered
questions derived from the first.

Properties:

- **The origin declares where execution resumes, as a code constant.** The model may divert,
  never choose a destination.
- **An origin's resume target is never upstream of the origin** — a question re-derives the
  plan, then proposes.
- **A material unknown is a core fact without which the plan would be a guess**: target
  role/domain, hours actually available, deadline. The model cannot forget to ask —
  `_clarify_request` refuses to plan around an unknown, and synthesises the question if the
  model omitted it. v1 shipped a bug where "I want to change the job" silently assumed
  software engineering; the forced gate is the fix, and it lives in one place rather than two
  that can drift apart.
- **Dedupe, not the budget, is the livelock guard.** `clarify_asked` records unknown names
  already asked *this turn*, so a resumed stage does not re-ask what it was just answered on.
  `clarify_rounds` (cap `MAX_CLARIFYING_ROUNDS = 3`) is a blunter budget over the user's
  patience, shared across stages. Using the budget as the livelock guard would mean a
  legitimate question is refused because an earlier one repeated.
- **Durability.** `thread_id = conversation_id`, so a paused plan survives a reload, a deploy,
  and a different server process. `POST /plan/run` with `answers` resumes.

**Confirmed in the running build:** a bare *"I want to switch jobs in 3 months"* does not
produce a plan — it produces two questions ("Which role or domain are you targeting?", "Roughly
how many hours a week can you give this?"). Answer them and the same thread returns
`kind=ok` with 97 rows across all five horizons. That is the mandatory-clarify invariant
working as designed.

**Confirm** is the second human gate, and it is not an interrupt: semantic proposals persist as
`proposals` rows and `POST /plan/confirm` applies one **atomically**, flipping status and
applying in a single step. v1's double-apply race is designed out here rather than patched.

### 6.8 The solver — placement

`place()` is **one CP-SAT model over every active goal**, not a call per goal. Multi-goal is in
scope from slice 1 because the shared weekly budget is a global constraint no per-goal loop can
express.

```
D       = ⋃ window(t)                        # candidate days, all goals
cap[d]  = blocked(d) ? 0 : availability[weekday(d)]
budget  = users.available_weekly_hours       # SHARED across goals
need[t] = max(1, round(est_hours(t) · 10))   # tenths of an hour — integer, no float drift
smax[t] = session_max_hours(t) ? round(it·10) : need[t]

vars    h[t][d] ∈ 0..min(need[t], smax[t], cap[d])   # tenths placed on day d
        u[t][d] ∈ {0,1}                              # h > 0 ⇔ u = 1
constr  Σ_d h[t][d] ≤ need[t]                        # never more than estimated
        Σ_t h[t][d] ≤ cap[d]                   ∀d   # per-day capacity
        Σ_{t,d : week(d)=w} h[t][d] ≤ budget   ∀w   # SHARED weekly cap
        h[t][d] ≤ min(need[t], smax[t]) · u[t][d]    # per-sitting cap
obj     max Σ (goal_prio(t)·100 + task_prio(t)·10) · h[t][d]
          − Σ days_from_window_start(d) · h[t][d]
solve   CpSat.solve(m, numWorkers=1)
```

**`place` is a validator/normalizer, not a generator.** It receives work items and is the only
thing that produces a date.

**A task may span several days** — this is the difference between a working planner and a
broken one. Under an earlier one-sitting-per-task formulation a 2.7h step against 2h/day
availability could never be placed; a measured run put **24 of 36 steps** on the fallback. With
integer tenths-of-an-hour `h[t][d]` the same run places **36 of 36**, and `session_max_hours`
caps one *sitting*, which is what it always meant.

**Reproducibility.** `numWorkers=1` plus integer tenths means the same input yields the same
plan. A plan must be reproducible; a deterministic solver is worth more than a fast one.

**The fallback is structural, not a second algorithm.** CP-SAT is a compiled dependency — it
can fail to import, time out, or return no solution, and the reliability contract says none of
that may reach the user. So there is exactly one fallback: every unscheduled item keeps its
`window_start`. No search, no heuristics, ~15 lines. v1's hand-written greedy is deliberately
**not** carried over — it is a second placement algorithm to maintain and keep consistent, for
a path that should be rare. Structural placement is worse but *obviously* correct.

`place` returns `{feasible, slots[], unscheduled[], short[], solver}`. `unscheduled` is a task
that got no hours; `short` is one that got fewer than its estimate. **Neither is dropped** —
unscheduled steps are kept and marked `(over capacity)`, so the user sees the shortfall rather
than a silently short plan.

**The lattice** (`build_lattice`) is the other pure core module: phase spans, milestone target
dates, the 80% working window inside each span, weekly bands stepping 7 days, and the
`part i/N` label when milestones run in parallel. Output is ordered yearly → quarterly →
monthly → weekly → daily, plus `spans[]` for the UI.

### 6.9 Verification — two layers, and the determinism trap

The solver is a *feasibility* engine, not a *sanity* engine. It can satisfy every constraint and
still be wrong: the final mock interview on day one, a deep-work block inside the user's
busiest week, a step before its prerequisite. No objective function encodes "this reads wrong".
So placement is verified twice.

**Layer 1 — `n_verify` (code, deterministic).** Hard invariants; a violation means the solver
is buggy or the fallback ran, so the turn ends `no_change` rather than shipping a bad plan:
per-day capacity never exceeded · the shared weekly budget never exceeded across all goals · no
task given more hours than it estimated · every slot inside its task's window · no slot on a
blocked day · every scheduled task traces to a plan item. This is arithmetic, it is cheap, and
a failure here is a bug to fix — not a plan to renegotiate.

**Layer 2 — `n_review` (LLM, semantic).** The judgment calls: sequencing, load distribution,
rhythm (honour "no deep work on weekdays"), and whether front-loading produced something
absurd.

**The determinism trap — why the critique must be constraints, not prose.**

> CP-SAT is deterministic. Re-running `n_place` with the same input returns the **identical**
> plan.

A naive "the LLM says it's wrong → run the solver again" loop cannot terminate; it spins on the
same answer until the round cap. The review's output must therefore *change the model's
input*:

```python
class ConstraintDelta(BaseModel):
    kind: DeltaKind      # precedence | allowed_days | avoid_week | max_per_day
                         # | session_max | pin | priority_bump
    task_id: str
    other: str | None
    value: str | int | list[int] | None
```

Every kind is expressible as a CP-SAT constraint, which is what keeps §6.1 intact: **the LLM
still never writes a date.** It adjusts the constraint set; the solver re-solves and remains
the only producer of a date. `deltas` accumulate in state across rounds, so round 2 sees round
1's constraints and the loop converges instead of oscillating. Capped at
`MAX_REVIEW_ROUNDS = 2`; exhausting it is `renegotiate` — the plan is feasible but the model
could not make it *sensible*, which is a real signal to surface rather than paper over.

This is the evaluator-optimizer pattern with one addition the docs don't cover: **when the
"optimizer" is a deterministic solver, feedback has to be structural rather than textual, or
the loop is a no-op.**

**What the solver does not decide: time of day.** The decision variable is a *day*, so no clock
time is produced anywhere in the model. *When* inside a day is the Time Block rung — a separate
concern needing a time-window availability model, explicitly out of scope.

### 6.10 Replan — the same graph, a different door

This is where v2 earns its keep. v1 spent ~2,200 lines (`action_intake` + `plan_relay` +
`staleness`) on a parallel replanning stack. v2 spends **one state field and one router**.

**Entry.** Any write route records the change *inside its own transaction* and fires the replan
after. There is no fire-and-forget relay step left to get wrong — v1's relay failure lost
changes silently, and six call sites passed an action string where a `goal_id` belonged.

**Blast radius → tier.** `classify_change` is pure and takes the blast radius as an
*argument*, so it stays testable with no DB.

| Blast radius | Tier | Behaviour |
|---|---|---|
| daily only | **slim** | `place` re-runs; day-level dates rewrite silently; toaster narrates `adjustments[]` |
| weekly or higher, or a milestone moved | **escalate** | minimal day-only changes apply immediately; the rest becomes proposals held for the confirm modal |

**The locked write buckets:** *scheduling fields are auto* (solver-written), *semantic fields
are confirm* (user-written). A user can reject the modal and still use the refresh button.

**`at_start` routes a slim replan straight to `n_place`.** A replan never re-enters the meaning
stages, because the meaning is what the user just edited by hand — re-deriving it would rewrite
the plan they were looking at. `run_replan` seeds a minimal delta rather than
`initial_state()`, because that helper fills every key and would wipe the very task set the
replan exists to re-solve.

**Verified in the running build:** plan → `run_replan(tier="slim")` returns `kind=ok`,
`tier=slim`, with the 97-row plan re-solved in place.

**One invariant: replace-on-write.** Every write to `plan_items` for a goal is
`DELETE ... WHERE goal_id = ?` + `INSERT` inside one transaction — and in graph state, the same
rule via `Overwrite`. v1 needed a whole backlog slice to chase append-duplicate and orphan rows
across four code paths; v2 makes the bug unrepresentable by having exactly one writer.

**Staleness is three columns, not 855 lines.** `goals.last_planned_at` (advanced on every
confirmed write), `goals.plan_generation` (integer, incremented on confirm), and an
append-only `plan_changes(goal_id, generation, kind, horizons_moved, detail, created_at)`. The
count is changes whose `generation == plan_generation` and `created_at > last_planned_at` —
**generation, not timestamp**, is what makes it monotonic inside a window and exactly zero
after a confirm. `build_adjustments` renders the toaster strings deterministically: same
ledger, same sentence order, so a re-render cannot reshuffle the toast under the user's eyes.

### 6.11 Failure ladder

**No model or solver failure ever 500s.** Every stage degrades; the worst case is `no_change`
with a `plan_rejects` row. Programmer errors still propagate loudly.

| Failure | Result |
|---|---|
| intake LLM error | `no_change` + `plan_rejects` row |
| clarify unanswered | `clarify` (state durable, resumable) |
| plan LLM error / empty plan | `no_change` |
| lattice failure | **non-fatal** — continue with raw items |
| solver infeasible / import error / timeout | structural placement; never drop a step |
| `n_verify` invariant violated | `no_change` — a solver bug, not a user-facing failure |
| `n_review` rejects, rounds < 2 | loop `n_place` with `ConstraintDelta[]` |
| `n_review` rejects, rounds = 2 | `renegotiate` — feasible but not sensible |
| headroom over budget | `renegotiate`, then `no_change` |
| propose LLM error | `no_change` |
| validate fails twice | `no_change` |

Each row maps to one of four error strategies — transient → retry policy; LLM-recoverable →
store the error and loop back; user-fixable → `interrupt()`; recoverable-after-retries →
`error_handler`; unexpected → **let it bubble for debugging**.

Two caveats on the ladder as it stands today. First, the transient and recoverable rows are
**designed, not wired**: there is no `RetryPolicy`, `TimeoutPolicy`, `error_handler` or
`set_node_defaults` in `app/graph/` — see §9.3, which also documents why dropping in a stock
policy would silently retry nothing. Second, the "never 500s" contract is upheld today by the
`result`-first routing in §6.3 plus the LLM seam's own error mapping, not by these hooks.

### 6.12 Observability & evaluation

**Tracing.** One turn lands as one trace: parent `plan.turn`, every node beneath it, and every
model call as an `llm.model_call` span carrying `ls_provider`, `ls_model_name` and the schema
name. Off unless a `LANGSMITH_API_KEY` is present. The TUI prints the trace URL under every
result.

**Per-stage reject log.** `plan_rejects(intent, stage, reason, recovered)` makes reject rate
measurable *per stage*, so stages tune independently. This is the product's primary quality
instrument.

**Evaluation plan.** Two different tools for two halves, which is exactly the meaning/dates
split:

- **Code evaluators** for `place` — feasibility, budget, nothing-dropped, determinism,
  objective-not-regressed. Mechanical claims, exact assertions, no judge, no cost.
- **One judge** for `n_review`, measuring the thing that actually degrades: *did the reviewer
  reject anything it could not express as a delta?* That is observable from the run, it is the
  loop's own invariant, and it tells you whether the evaluator-optimizer loop is converging or
  spinning.

The docs' own warning applies: validate a judge against human labels before trusting it,
starting with ~20 balanced examples.

### 6.13 Determinism & testability guarantees

- **`core/` is pure.** It imports no DB, network or LLM client — and
  `apps/agent/tests/unit/test_purity.py` mechanically enforces it (nothing from `store`, `llm`,
  `graph`, `api`, `psycopg`, `httpx`, `fastapi`, `langgraph`).
- **`complete` is injected, never imported by a node.** `build_plan_graph(*, complete,
  checkpointer)` captures it in the node closures. Tests pass a fake and run the whole graph
  with no model — 73 offline tests, no network, no DB.
- **A deterministic offline stub** serves every stage when no API key is set. This is
  deliberate: the entire product runs with no network and no credentials, which is what makes
  the graph testable and the demo reproducible.
- **Golden runs per intent**; node-level tests with a fake `complete`; a full HITL
  pause → persist → resume across two separate calls.

> **Warning for anyone debugging a plan that looks too tidy:** with no LLM key set, a broken
> model wiring is *indistinguishable* from a working one. Check it explicitly.

---

## 7. Product surface

### 7.1 Shape of the system

```
apps/web (React 19)      apps/api (FastAPI)             apps/agent (library)         Postgres
───────────────────      ──────────────────             ────────────────────         ────────
Plan workspace ─plan─▶ POST /plan/run ──in-process──▶ plan_graph ──▶ LLM              goals
  refresh button        POST /plan/confirm              ├─ lattice (pure)             milestones
  toaster               POST /plan/change               ├─ decompose (LLM)            plan_items
                        GET  /plan/staleness            ├─ place (CP-SAT, writes)     blockers
  ◀── SSE frames ───────────────────────────────────────┴─ checkpointer ────────────▶ checkpoints
```

**One HTTP surface.** `apps/web` talks to `apps/api` and nothing else. `apps/agent` is a
*library* with no routes of its own, imported in-process — the boundary between them is a
function call, not a network hop. The frontend is an API consumer first; the storybook app
(`apps/storybook`) is a UI harness used to click through the app and file bugs, not a shipped
surface.

### 7.2 HTTP surface

`openapi.yaml` documents **38 paths / 56 operations**, in 15 tag groups. All routes are served by
`apps/api`; `openapi.yaml` is the contract, and `CONTRACT-RECONCILIATION.md` is authoritative
where they disagree.

| Tag | Routes | Purpose |
|---|---|---|
| `auth` | `POST /session`, `/guest`, `/logout`, `GET /me`, dev-only `GET\|POST /dev-login`, `GET\|DELETE /personas[/{userId}]` | Identity. One resolver (`deps.resolve_user`), no second path |
| `planning` | `POST /plan/run`, `/plan/change`, `/plan/confirm`, `/plan/stream`, `GET /plan/staleness` | The planner surface |
| `state` | `GET /state` | The dashboard read model — the whole app in one snapshot |
| `goals` | `GET /goals`, `GET /goals/{id}`, `POST /goals`, `PATCH /goals/{id}`, `DELETE /goals/{id}` | Goals |
| `plan-items` | `POST /plan-items`, `PATCH /plan-items/{id}`, `GET /milestones`, `PATCH /milestones/{id}` | Rows on the schedule of record |
| `blockers` | `GET /blockers`, `POST /blockers`, `PUT /blockers/{id}`, `DELETE /blockers/{id}` | Date windows that remove capacity |
| `timetable` | `GET /timetable`, `POST /timetable`, `PUT /timetable/{id}`, `DELETE /timetable/{id}` | Fixed weekly commitments — the availability model |
| `state` | `GET /daily_log`, `PUT /daily_log` | What actually happened (shares the `state` tag) |
| `sources` | `GET /sources`, `POST /sources/upload`, `POST /sources/link`, `/link/preview`, `/link/extract`, `/link/ask`, `GET /sources/{id}`, `/download`, `PATCH /sources/{id}`, `DELETE /sources/{id}` | Attached material |
| `memories` | `GET /memories`, `POST /memories`, `DELETE /memories/{id}` | Durable facts about the user |
| `preferences` | `PUT /preferences`, `GET /preferences/models` | Model choice, user settings |
| `motivation` | `GET /motivation/recommend` | The nudge bucket |
| `audit` | `GET /audit`, `GET /audit/export` | Change history |
| `tools` | `POST /tools/confirm`, `POST /tools/reject` | The confirm gate on proposals |
| `chat` | `POST /chat/stream`, `/chat/plan`, `/chat/refine`, `GET\|DELETE /chat/history` | Conversational turns |
| `ops` | `GET /health`, `GET /ready` | Probes |

### 7.3 Data model

**22 tables.** Core domain: `users`, `user_sessions`, `goals`, `milestones`, `plan_items`,
`blockers`, `timetable_blocks`, `sources`, `memories`, `user_facts`, `conversations`,
`messages`, `proposals`, `daily_log`. Planner-specific: `plan_threads`, `plan_rejects`,
`plan_staleness`, `plan_change_ledger`. Motivation: `motivation_cache`,
`motivation_rejects`, `motivation_served_log`. Plus `audit_log`.

`plan_items` is **the schedule of record** — all five horizons in one table, single writer,
replace-on-write. Its docstring states the invariant: *"The solver is the only writer of the
dates."* A user-owned daily task is the one exception: created by `POST /plan-items`, only its
`status` is editable.

### 7.4 SSE frames

`apps/api/sutra_api/stream.py` is the executable version of the frame union; the spec carries it
as an `x-sse-frames` extension because OpenAPI cannot describe a stream. Every frame was
verified against the client, and five disagreed with the spec:

| frame | fields | note |
|---|---|---|
| `delta` | `content` | the spec says `text`; the client reads `content` |
| `tools` | `message_id`, `proposals` | the client **replaces its message id** from this frame |
| `needs_clarification` | `message_id`, `prompt`, `questions` | `thread_id` added for the v2 planner |
| `impact` | `impact` | missing from the spec entirely |
| `plan` | `node`, `detail` | v2-only progress |
| `done` | `message_id`, `provider`, `ref_id`, `conversation_id`, `redirected`, `text` | |
| `error` | `content` | the spec says `detail` |

Only prose goes through `delta`; the tool block is suppressed from the stream.

### 7.5 UI surfaces

The storybook harness renders: Overview · Plan · Goals (state) · Today · Timeline · Memories ·
Sources · Curated (motivation) · Settings. Per principle 4, only two surfaces are *locked* into
the product contract — the refresh button and the toaster.

---

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| **Determinism** | Every `core/` function is pure: identical input ⇒ identical output. Enforced by a test that imports `core/` with no DB driver, HTTP client or LLM SDK installed |
| **Idempotency** | Replace-on-write plus a proposal-status guard means a retried confirm cannot double-apply |
| **Latency** | 4 LLM calls on the happy path (intake, plan, decompose, propose) + 1 for the review, +1 per extra review round (cap 2). `place` is offline and CPU-bound: **one** CP-SAT call over every active goal, `numWorkers=1`, target < 1s for a 5-goal plan |
| **Bounded work** | `n_place` is meant to be the only node with a `TimeoutPolicy` — the search is the only unbounded work in the graph. **Not yet wired** (§9.3). `_RECURSION_LIMIT = 50` *is* set explicitly, because `GraphRecursionError` is neither `LlmError` nor `ValueError` and would escape `ainvoke`, breaking "never fail" |
| **Cost** | One plan-wide solve rather than per-week solves; `MAX_TOOLS = 16` cap; tracing off unless a key is set |
| **Security** | Auth has exactly one resolver. No CSRF token — `security.origin_is_same_site` enforces an origin check on every mutating request and **fails closed**. The link-preview fetch is the one outbound request to a user-chosen host, guarded three ways (syntactic, resolved via `getaddrinfo` re-check, and per-hop on redirects), refusing on DNS failure |
| **Degradation** | The planner is flag-gated (`GOAL_PLANNER_ENABLED`, `GOAL_PLANNER_USER_ALLOWLIST`) and can be dark-launched per user. A disabled planner returns `{"status": "disabled"}` rather than a 4xx, so a feature flag never looks like a failure |
| **Compatibility** | Newest graph runs against old checkpoints: never rename or remove a node a thread may be paused at, never rename or remove a state key, never tighten a field. Add keys as `NotRequired` |
| **Checkpoint retention** | Checkpoints grow unbounded and must be pruned — an operational requirement, not an optimisation. `ephemeral-*` threads are safe to drop wholesale; `conversation-*` threads are not |

---

## 9. Known gaps and defects

Listed because a PRD that hides its own state is not useful. Sourced from the verified design
review.

### 9.1 `n_review` is fed no meaning — **highest-value fix, cheapest**

The review input is built as `f"- {s['task_id']} {s['date']}"` — so the model receives
`- w0s1 2026-10-12` and nothing else. No titles, no estimated hours, no phase, no goal, no
milestone. Meanwhile the prompt asks it to judge sequencing, load, rhythm and absurdity. It
cannot answer any of those. The semantic verification layer — the entire reason `n_review`
exists — is currently reasoning over opaque keys. This is also why the loop can burn both
rounds and land on `renegotiate`. The data already exists in `state["tasks"]` and
`state["plan"]`.

### 9.2 The `rejects` reset is a silent no-op — **verified**

`rejects: Annotated[list[dict], operator.add]`, and `initial_state()` sets `"rejects": []`
intending a fresh turn. It does not clear: the empty list merges and the old entries survive.
Reproduced — three turns produce three accumulated entries. Consequence: on a long-lived
`conversation-*` thread the list and the checkpoint grow without bound, and **every turn's API
payload carries the whole thread's reject history**. Fix is `Overwrite([])`.

### 9.3 Reliability hooks were never built — **verified**

There is no `RetryPolicy`, `TimeoutPolicy`, `error_handler` or `set_node_defaults` anywhere in
`app/graph/`. Adding a stock `RetryPolicy` is not the fix by itself: `retry_on` defaults to
`default_retry_on`, which excludes `RuntimeError` — and every model failure arrives as
`LlmError(RuntimeError)`. A stock policy would retry **nothing**. Any policy needs an explicit
`retry_on` including `LlmError`. `ConnectionError` is an `OSError` subclass, so even the
network case needs opting in.

### 9.4 Two writers of daily dates

`build_lattice` writes `start_date`/`end_date`/`due_date` on every row it emits — including one
daily row per calendar day in every band. The solver's slots are a second, independent
statement about the same days. This is the pattern HLD §3 names as v1's bug, one layer up.
`test_purity.py` asserts only that nothing outside `place.py`/`fallback.py` constructs a
`Slot(...)`, so it passes while the invariant it names is false.

### 9.5 `max_per_day` does not mean what its schema says — **verified**

The schema says "at most N sittings on any one day" (a per-task rule). The implementation takes
`min()` across every task that declared the delta and applies one cap to the **union** of those
tasks. So: with one declaring task the delta is a **no-op**; with two it becomes an undocumented
shared cap; and `min()` collapses two different values into one. `session_max` is the delta that
actually caps per-day hours.

### 9.6 The front-load term competes with priority

Priority spans 110–550 in the objective; the unweighted day-offset penalty spans 0–540 over a
long horizon. Same magnitude, so front-loading can outrank goal priority — the opposite of the
design's "contested hours go to the higher-priority goal". The HLD calls this term a
"tie-break"; at this scaling it is a second objective.

### 9.7 A weekly band's hours disagree with its own daily rows

`_band_hours()` ignores `active_count` and returns the full `weekly_hours`, while
`_per_day_hours()` divides by it. With two parallel milestones in a band the band claims N hours
and its daily rows sum to N/2 — and `n_decompose` puts the full figure into the prompt.

### 9.8 Configured provider is not the provider in use — **verified**

`resolve_provider()` prefers `SUTRA_LLM_*` over `DEEPSEEK_*`, and with the current `.env` the
override half-wins: the model in use is `deepseek-flash`, not the `deepseek-v4-pro` the
`DEEPSEEK_` block appears to intend. `SUTRA_LLM_MODEL` also appears twice in the file, and
`ls_provider` reports `"configured"`, which will never match a pricing entry named `deepseek` —
so cost tracking fails even once token capture is fixed.

### 9.9 The design gap: there is no long-term memory

The product's entire premise is remembering who the user is. "I'm a dancer", "works in
fintech", "trains six days a week" are exactly the durable facts `prompts.FACTS` was written to
extract — and today there is nowhere to put them. `FACTS` is defined and referenced by
**nothing**. There is no Store (`AsyncPostgresStore`) and no `context_schema`; the user id is a
plain state key rather than runtime context, so it is checkpointed and available to prompts.
Every turn re-derives the user from a transcript. The `memories` table exists, so the
persistence half is closer than the extraction half.

### 9.10 Smaller items

`mode` (`auto|ask|grill`) is written into state and read by no node · `deltas` has no reducer
while `rejects` does, and `n_review` hand-merges it · `tid_label()` in `validate.py` is an
identity function used inconsistently two lines apart · `_bands`' `part i/N` loop can only ever
produce `part 1/N` · `n_decompose` guards its fallback with `if "note" in dir():` ·
`core/drift.py` named in the HLD does not exist as a module in the agent (drift lives in
`apps/api/sutra_api/core/drift.py`) · `flow_version` is not stamped at thread start ·
`durability="sync"` is not set on the plan-writing run.

---

## 10. Metrics

**Product.** Week-2 retention of the founder as a daily user — the exact metric every
competitor fails. Plans confirmed per week. Replan events per week, split slim vs escalated
(a healthy plan absorbs small changes silently and escalates rarely).

**Agent quality, per stage.** `plan_rejects` reject rate by stage — the resolution instrument
that lets stages be tuned independently. Review-loop convergence rate (rejections that produced
a usable delta vs. spins to the cap). Clarify rate per stage, and clarify answer rate (a
question the user ignores is worse than no question). Placement quality: `unscheduled[]` and
`short[]` counts, which should both be near zero.

**Cost & latency.** Model calls per turn; tokens and cost per turn (blocked on the token
capture fix); `place` wall time against the 10s bound.

**Explicitly not a metric yet:** DAU growth, engagement loops, any multi-user signal. There is
one user.

---

## 11. Roadmap & status

| # | Slice | Status |
|---|---|---|
| 0 | Scaffold `apps/agent` | ✅ done |
| 1 | **Pure core** — `util`, `lattice`, `place` (CP-SAT, multi-goal, shared weekly budget), `validate`, `headroom`, `staleness` | ✅ done, 73 offline tests |
| 2 | Contracts — `schemas.py`, `prompts.py`, schema tests | ✅ done |
| 3 | Graph, headless — 12 nodes incl. `n_verify` and the review loop, fake `complete`, golden runs | ✅ done |
| 4 | Persistence — checkpointer, repo, replace-on-write, `POST /plan/run` | ✅ done in `apps/api` |
| 5 | HITL — clarify interrupt + resume from any stage, confirm, mandatory-clarify invariant | ✅ done |
| 6 | **Replan** — `/plan/change`, blast radius → tier, `adjustments[]`, staleness count | ✅ done |
| 7 | Solver hardening — timeout → structural fallback, property tests | ⏳ partial (§9.3) |
| 8 | Streaming — SSE adapter + web wiring | ✅ done |
| — | **Long-term memory / Store** (§9.9) | ❌ not built — the largest gap |
| — | `/chat/*` chat graph (`sutra_chat`) | ⏳ package exists; routes not wired |
| — | Motivation `_generate()` — route, cache contract and bucket logic work; returns an empty set | ⏳ needs a search key and critique loop |
| — | PDF / DOCX / image extraction | ❌ `core/extract.py` names the gap; an empty excerpt is already handled |
| — | `/plan/runs` baseline table | ❌ `/plan/confirm`'s 409 uses the conversation's `last_message_at` as the baseline — correct for the normal flow, with a one-request-wide window |

**Recommended order for the next iteration:** (1) give `n_review` the placement's meaning
(§9.1 — highest value, cheapest); (2) `Overwrite` the `rejects` field (§9.2); (3) fix the retry
policy wiring (§9.3); (4) long-term memory (§9.9); (5) decide who owns daily dates (§9.4);
(6) fix or delete `max_per_day` (§9.5).

Items 1–3 need no new dependency.

---

## 12. Glossary

**Goal** — the thing the user wants, sized into a horizon window. **Milestone** — an outcome
checkpoint, rendered as an overlay chip, *never* a plan level. **Lattice** — the deterministic
skeleton: phase spans, milestone dates, week bands, the 20% buffer. **Plan item** — one row of
the schedule of record, in one of five horizons. **Daily task** — the finest rung. **Time
block** — *when* inside a day; out of scope. **Slim replan** — day-level, automatic, narrated by
the toaster. **Full replan (escalate)** — week-or-higher, held for the confirm modal.
**Constraint delta** — the only way the LLM may influence the schedule: a structural change to
the solver's input, never a date. **Material unknown** — a core fact without which the plan
would be a guess. **Blast radius** — how much of the user's plan a sentence changed, and the
input to the replan tier. **Kind** — a run's terminal outcome: `ok | early | no_change |
renegotiate | clarify`.
