# Agent design review — what the LangChain/LangGraph docs change about Sutra

**Status:** review. Companion to [`HLD-planning-agent.md`](HLD-planning-agent.md).
Not a feature plan — this is about the *shape of the agent*.

**Method.** Four passes over the OSS design docs (`oss/python/langgraph/*`,
`oss/python/langchain/*`, `oss/python/deepagents/*`, and the eval pages), then a
read of the whole agent: all 11 nodes, `routers.py`, every `core/` module,
`contracts/schemas.py`, `build.py`, the tests, and the `.env`. Findings marked
**verified** were reproduced by running code in this repo; the rest are read
from source.

---

## 1. The verdict, first

**The architecture is right, and the docs say so in their own words.** Almost
everything in §2 is here because the docs independently arrived at the same
place. The problems are not structural — they are (a) a handful of genuinely
wrong implementations, (b) written-but-unbuilt machinery, and (c) one design
gap the docs are unambiguous about: **there is no long-term memory and no
store.**

The single most useful reframing the docs offer: *the agent is not failing
because the model is wrong; it is failing because the right context is not
reaching it.* `context-engineering.md`: "LLMs fail for one of two reasons: 1.
The underlying LLM is not capable enough 2. The 'right' context was not passed
to the LLM. **More often than not - it's actually the second reason**." That is
exactly the shape of the biggest defect below (§3.1): a reviewer being asked to
judge things it has not been told.

---

## 2. What the docs validate — do not "improve" these

| Our decision | The doc that agrees, and what it says |
|---|---|
| **A workflow, not a free-running agent** | "Workflows have predetermined code paths and are designed to operate in a certain order." An agent is for when "problems and solutions are unpredictable". Ours are not. |
| **A deterministic solver as a node in the graph** | `overview.md`: "mix deterministic, hand-coded steps with LLM-driven agentic steps in the same graph … parts of the logic are fully predictable and auditable while other parts are flexible and model-driven". Their RAG example labels such a node "**Deterministic node** … no LLM involved". |
| **The LLM never writes a date** | `tools.md`: "Some policies can't live in a prompt—they need to be enforced deterministically regardless of what the model does." Dates are that class of thing. |
| **Prompt chaining (one call per stage, gated)** | "each LLM call processes the output of the previous call … well-defined tasks that can be broken down into smaller, verifiable steps." |
| **One `interrupt()`, looped by a conditional edge** | This is verbatim the sanctioned shape: "call `interrupt()` **once per node invocation**, … and use a conditional edge to loop back". |
| **`n_place → n_review` with structured deltas** | The evaluator-optimizer pattern: "one LLM call creates a response and the other evaluates that response … This loop continues until an acceptable response is generated." |
| **No tool-calling loop** | Nothing in the docs argues a stage-per-call design needs one. |
| **11 granular nodes** | The four stated reasons to split: "Isolation of external services / Intermediate visibility / Different failure modes / Reusability and testing" — and "More nodes doesn't mean slower execution". |
| **`extra="ignore"` on LLM-filled models** | Consistent with the docs treating the schema as a guide that is validated after the fact. |
| **A purity test on `core/`** | The docs' own testability principle: "create your graph before each test … compile it within tests with a new checkpointer instance"; nodes invocable "in isolation". |
| **One repair round-trip** | The docs' `ToolStrategy.handle_errors=True` default is the same mechanism, and their loop has *no* cap at all — ours is stricter. |

---

## 3. Verified defects

### 3.1 `n_review` cannot do its job — it is fed no meaning

[nodes.py:338](../../apps/agent/app/graph/nodes.py) builds the review input as:

```python
placement = "\n".join(f"- {s['task_id']} {s['date']}" for s in slots)
```

So the model receives `- w0s1 2026-10-12` and nothing else. No titles, no
estimated hours, no phase, no goal, no milestone. Meanwhile `prompts.REVIEW`
asks it to judge:

> "sequencing: does a step land before its prerequisite? · load: is the hardest
> work crammed into the user's busiest week? · rhythm: does it ignore a stated
> preference? · absurdity: is a culminating step (a final mock, a launch)
> placed first?"

It cannot answer any of those. A task id is opaque; a date is not meaningful
without knowing what is being placed and how long it takes. The semantic
verification layer — the entire reason `n_review` exists, and the thing HLD §8.6
calls "the judgment calls" — is currently reasoning over a list of opaque keys.

This is also why the loop can burn both rounds and land on `renegotiate`: the
reviewer has no basis to approve, and when it rejects it must invent deltas
against ids it does not understand.

**This is the highest-value fix in this document.** It is also the cheapest: the
data already exists in `state["tasks"]` and `state["plan"]`.

### 3.2 The `rejects` reset is a silent no-op — verified

[state.py:70](../../apps/agent/app/graph/state.py) declares
`rejects: Annotated[list[dict], operator.add]`. `initial_state()` sets
`"rejects": []` intending a fresh turn per run.

The docs name this exact trap: *"with a merging reducer, returning an empty
value does **not** clear the field. Because the reducer merges the right
argument into the left one, an empty update is merged in and previously
accumulated values are kept."* The remedy is `Overwrite([])`.

Reproduced in this repo against the same annotation:

```
turn 1 input {rejects: []}: [{'stage': 'x'}]
turn 2 input {rejects: []}: [{'stage': 'x'}, {'stage': 'x'}]
turn 3 input {rejects: []}: [{'stage': 'x'}, {'stage': 'x'}, {'stage': 'x'}]
```

Two consequences, both live:

- `_REPLAN_RESET` ([build.py](../../apps/agent/app/graph/build.py)) does not
  reset `rejects` either, so nothing ever clears it. On a long-lived
  `conversation-*` thread the list — and therefore the checkpoint — grows
  without bound. The docs' mitigation is pruning or retention; the fix here is
  `Overwrite`.
- `_shape_result` reads `out["rejects"]` from the final state, so **every
  turn's API payload carries the whole thread's reject history**. Confirmed
  forwarded to the client at
  [plan.py:79](../../apps/api/sutra_api/api/plan.py). Today this is noise, not
  corruption — `PlanReject` exists but nothing writes it yet — but it is wrong
  the moment slice 4 lands, and it is the kind of wrong that shows up as
  duplicate rows.

### 3.3 Retries would be a silent no-op if added naively — verified

There is **no** `RetryPolicy`, `TimeoutPolicy`, `error_handler` or
`set_node_defaults` anywhere in `app/graph/` — the HLD's own reliability hooks
(§6, §8.2, §13) were never built.

But adding `RetryPolicy()` is not the fix by itself. The docs: `retry_on`
defaults to `default_retry_on`, which "retries on **any** exception except …
`ValueError`, `TypeError`, `ArithmeticError`, `ImportError`, `LookupError`,
`NameError`, `SyntaxError`, **`RuntimeError`**, …". And our seam raises:

```python
class LlmError(RuntimeError):   # app/llm/client.py
```

Reproduced:

```
LlmError               -> default_retry_on = False
httpx.ConnectError     -> default_retry_on = True
TimeoutError           -> default_retry_on = False
```

So a stock `RetryPolicy` on `n_intake`/`n_plan`/`n_decompose`/`n_review`/
`n_propose` would retry **nothing** — every model failure in this agent arrives
as a `RuntimeError` subclass, which is explicitly on the do-not-retry list. Any
retry policy must pass an explicit `retry_on` that includes `LlmError`.

Note also `ConnectionError` is an `OSError` subclass, so even the network case
needs opting in.

### 3.4 Two writers of daily dates, and the purity test cannot see it

`PlanItemRow`'s own docstring says "The solver is the only writer of the dates."
`build_lattice` writes `start_date`, `end_date` and `due_date` on every row it
emits — including **one daily row for every calendar day in every band**
([lattice.py:144](../../apps/agent/app/core/lattice.py)).

That is the pattern HLD §3 names as v1's bug ("hand-written arithmetic stamped a
task on every calendar day"), reappearing one layer up. The daily lattice rows
and the solver's `slots` are two independent statements about the same days,
surfaced together in the result.

`test_purity.py` asserts only that nothing outside `place.py`/`fallback.py`
constructs a `Slot(...)` — so it passes while the invariant it names is false.

### 3.5 `max_per_day` does not mean what its schema says — verified

Schema: *"at most N sittings on any one day"* (a per-task rule). Implementation
([place.py:278](../../apps/agent/app/core/place.py)) takes `min()` across every
task that declared the delta and applies one cap to the **union** of those tasks,
per day.

Reproduced with 3 tasks at 2h in an 8h/day week:

```
baseline (no delta)      : 10-12: [w0s0, w0s1, w0s2]
delta on ONE task        : 10-12: [w0s0, w0s1, w0s2]      ← identical to baseline
delta on TWO tasks (1,1) : 10-12: [w0s0, w0s2]  10-13: [w0s1]
delta on TWO tasks (1,3) : 10-12: [w0s0, w0s2]  10-13: [w0s1]   ← (1,3) == (1,1)
```

So: with one declaring task the delta is a **no-op**; with two it becomes an
undocumented shared cap; and `min()` collapses two different per-task values
into one. A delta kind the reviewer is invited to emit does nothing in the case
the schema documents.

(It is also worth asking whether `max_per_day` has *any* per-task meaning in
this model: a task already has at most one `h[t][d]` variable per day, so
"at most N sittings on a day" is vacuous for one task. `session_max` is the
delta that actually caps per-day hours.)

### 3.6 The objective's front-load term is not a tie-break

[place.py:169](../../apps/agent/app/core/place.py):

```python
weight = gp * GOAL_PRIO_WEIGHT + t.priority * TASK_PRIO_WEIGHT   # ∈ [110, 550]
terms.append(weight * var)
terms.append(-days_between(t.window_start, d) * var)             # unweighted, ∈ [0, 540]
```

Priority spans 110–550; the day-offset penalty spans 0–540 for a long horizon.
They are the same magnitude, so front-loading can outrank goal priority — the
opposite of HLD §8.3's "contested hours go to the higher-priority goal". HLD
calls this term a "tie-break"; at this scaling it is a second objective.

### 3.7 A weekly band's hours disagree with its own daily rows

`_band_hours(weekly_hours, active_count)` ignores `active_count` and returns the
full `weekly_hours`; `_per_day_hours(...)` divides by it. With two parallel
milestones in a band, the band claims N hours and its daily rows sum to N/2.

This propagates: `n_decompose` reads `i.weekly_hours` off the weekly row and
puts it in the prompt (`f"- {i.title} | {i.weekly_hours or 2:g}h"`), so the
model is told the full weekly load for each of the parallel tracks.

### 3.8 Configured provider is not the provider being used — verified

`resolve_provider()` prefers `SUTRA_LLM_*` over `DEEPSEEK_*`. With the `.env`
as it stands (`SUTRA_LLM_BASE_URL` set, `SUTRA_LLM_API_KEY` **empty**,
`SUTRA_LLM_MODEL=deepseek-flash`, `DEEPSEEK_MODEL=deepseek-v4-pro`):

```
EFFECTIVE -> name : configured
EFFECTIVE -> model: deepseek-flash
ls_provider metadata sent to LangSmith = 'configured'
```

Three consequences:

1. The model in use is `deepseek-flash`, **not** the `deepseek-v4-pro` the
   `DEEPSEEK_` block appears to intend. The override half-wins.
2. `SUTRA_LLM_MODEL` appears **twice** in the file.
3. `ls_provider` is `"configured"`, which will never match a pricing entry
   named `deepseek` — so cost tracking fails even after token capture is fixed.

---

## 4. Gaps between what the HLD says and what exists

| HLD says | Reality |
|---|---|
| §15 "v2 uses `context_schema` as the primary mechanism" for DI | No `context_schema`; DI is node closures. (The closure seam works; the doc is wrong about the mechanism.) |
| §11.1 `durability="sync"` on the run that writes a plan | No `durability` passed anywhere — default `async`, which the docs describe as having "a small risk that LangGraph does not write checkpoints if the process crashes during execution". |
| §11.1 stamp `flow_version` at thread start | Not in `PlanState`. The docs' business-compatibility pattern ("record the relevant *behavioral version* on the state at thread start") is unbuilt. |
| §11.2 long-term memory via `AsyncPostgresStore` | No store of any kind. `prompts.FACTS` is defined and referenced by **nothing** — so the only surviving trace of the feature is a prompt string. |
| §6/§8.2 `TimeoutPolicy` on `n_place`, `error_handler=` per node | Absent (§3.3). |
| §5 `core/drift.py` | Does not exist. |
| §7 `PlanState.slots` | No `slots` key; the field is `place`. |
| §8.6 delta kind `spread` | The code has `max_per_day`, and it does not do what it says (§3.5). |

Plus: `mode` (`auto|ask|grill`) is written into state and read by no node;
`deltas` has no reducer while `rejects` does (and `n_review` hand-merges it);
`tid_label()` in `validate.py` is an identity function, used inconsistently two
lines apart; `_bands`' `part i/N` loop can only ever produce `part 1/N`;
`n_decompose` guards its fallback with `if "note" in dir():`.

---

## 5. The design gap the docs are unambiguous about: memory

The docs give a clean three-bucket taxonomy, and we implement only the middle
one:

| Bucket | Scope | Access | Ours |
|---|---|---|---|
| **Runtime context** | per run, static | `context=` / `Runtime` | ✗ (identity is a plain state key) |
| **State** | per thread | graph state | ✓ |
| **Store** | cross-thread | `runtime.store` | ✗ **none** |

`persistence.md`: stores are for "long-term, cross-thread memory, including user
preferences, facts, and shared knowledge." `context-engineering.md` lists the
same three and adds the security rule the deep-agents pages spell out: "**Default
to user scope** `(user_id)` unless you have a specific reason to share."

We are building a *goal coach* — a product whose entire premise is remembering
who the user is. "I'm a dancer", "works in fintech", "trains six days a week"
are exactly the durable facts `prompts.FACTS` was written to extract, and today
there is nowhere to put them. Every turn re-derives the user from a transcript.

Two placement rules from the docs that decide how to build it:

- The user id must **not** come from state or the prompt — it is runtime
  context, so it belongs in `context_schema`/`Runtime`. That also stops it
  being checkpointed and rendered into prompts.
- Store search has three silent traps: prefix match is not exact, results past
  `limit` are "silently truncated … no overflow signal", and ordering is
  backend-dependent. Paginate and sort client-side on `updated_at`.

---

## 6. What to change, in order

Ordered by value ÷ cost. Items 1–3 need no new dependency.

| # | Change | Why (grounded) |
|---|---|---|
| 1 | **Give `n_review` the placement's meaning** — titles, `est_hours`, phase, goal, availability, the user's stated rhythm | §3.1. The reviewer cannot evaluate what it cannot see |
| 2 | **`Overwrite` the `rejects` field; return only this turn's rejects in the result** | §3.2 — the documented reducer trap, reproduced |
| 3 | **`asyncio.to_thread` around `place()`, then `TimeoutPolicy` + `RetryPolicy(retry_on=…LlmError…)`** via `set_node_defaults` | §3.3/§3.5-of-docs. Timeouts are async-only, and a stock policy would retry nothing because `LlmError` is a `RuntimeError` |
| 4 | **Fix the `.env` override block** (or delete it) so the intended model and an honest `ls_provider` are in effect | §3.8; cost tracking depends on it |
| 5 | **`response_schema` on the clarify interrupt** | Typed, validated resume values — and Studio renders a form. Note it adds a *new* failure (a `ValidationError` on resume), which is user-fixable and retryable on the same thread |
| 6 | **Decide who owns daily dates** — lattice or solver, not both | §3.4; and extend `test_purity.py` to enforce whichever wins |
| 7 | **Fix or delete `max_per_day`** | §3.5 — verified no-op in the documented case |
| 8 | **Weight or remove the front-load term** | §3.6 — it currently competes with priority |
| 9 | **Long-term memory: `AsyncPostgresStore`, namespace `(user_id, "memories")`, write `FACTS` behind a node** | §5 — the product's premise |
| 10 | **Stop storing rendered text in state** — keep `context` as raw rows, format in the node | "your state should store raw data, not formatted text. Format prompts inside nodes" |
| 11 | **`flow_version` at thread start; `durability="sync"` on the plan-writing run** | HLD §11.1, unbuilt; the docs' business-compatibility pattern |
| 12 | **`RemainingSteps`-style proactive termination on the review loop** | So a runaway evaluator lands in `no_change` rather than `GraphRecursionError` |
| 13 | **`runtime.execution_info.node_attempt`** for "on the second attempt, take the degraded path" | The docs' cleanest mechanism for our never-fail contract |
| 14 | **Housekeeping**: `mode`, `FACTS`, `tid_label`, `part i/N`, `if "note" in dir():`, `deltas` reducer, HLD §5's `drift.py` | Dead code and drift; each is minutes |

### On testing (the docs are specific and we are already close)

- `graph.nodes["n_place"]` invokes a node "in isolation" — a direct fit for the
  72 offline tests, and a way to test `n_review`'s new input shape.
- `update_state(..., as_node="n_place")` + `invoke(..., interrupt_after="n_review")`
  windows a sub-path so a mid-graph change can be tested without re-running the
  front of the pipeline.
- **"Assert on structure, not content."** Our stub-based tests already do this;
  keep it as the rule for anything that touches a model.
- Split integration tests behind a marker — the docs' rule, and ours already
  follows it (integration tests hit the shared Supabase).

### On evaluation

Two different tools for two different halves, which is the split the HLD's own
meaning/dates boundary already implies:

- **Code evaluators** for `place` — feasibility, budget, nothing-dropped,
  determinism, objective-not-regressed. Mechanical claims, exact assertions, no
  judge, no cost.
- **One judge** for `n_review`, measuring the thing that actually degrades:
  *did the reviewer reject anything it could not express as a delta?* That is
  observable from the run, it is the loop's own invariant, and it is the metric
  that tells you whether the evaluator-optimizer loop is converging or spinning.

The docs' own warning applies: "LLM-as-judge evaluators require careful review of
scores and prompt tuning" — validate a judge against human labels before
trusting it, starting with ~20 balanced examples.

---

## 7. What not to do

- **Don't make it more agentic.** Every doc surface works *better* on a graph
  with named nodes. "Start simple — begin with static prompts and tools, add
  dynamics only when needed."
- **Don't add subagents or multi-agent orchestration.** "not every complex task
  requires this approach—a single agent with the right tools and prompt can
  often achieve similar results." Our 11-node graph already *is* the centralized
  control a supervisor pattern buys.
- **Don't add a tool-calling loop.** Prompt chaining is the documented pattern
  for this shape and the docs' criterion for an agent — unpredictable problems —
  does not hold.
- **Don't switch the graph to the Functional API.** It has *stricter*
  production-change semantics than the Graph API, which is the opposite of the
  impression `choosing-apis.md` gives.
- **Don't put the JSON schema back in the template's variable space.** Today
  the schema is appended *after* `.format()`, which is why literal braces are
  safe. That safety is an ordering accident, not a property — worth a comment in
  `_prompt_with_schema` so nobody "tidies" it.

---

## 8. One correction to the HLD's own story

HLD §1.1 argues: "This is a workflow, not a free-running agent" and cites the
docs' over-engineering warnings. The conclusion is right, but the warning it
leans on is not there — `workflows-agents.md` contains **no** anti-over-engineering
language at all; the only "Before: Over-engineered Graph API" label is in
`choosing-apis.md`, about the Graph-vs-Functional choice, not about agency. The
correct citation is the *definition* ("workflows have predetermined code paths"),
which is stronger anyway.

Similarly, HLD §13's error taxonomy is right but its home is
`thinking-in-langgraph.md`, not `fault-tolerance.md`, and there is no
`node-retries.md`, `use-timeout.md` or `circuit-breaker` page — those URLs would
404. Worth fixing before someone cites them.
