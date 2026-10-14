# LangSmith for the Sutra agent — what to use, what to skip, in what order

**Status:** proposed. Companion to [`HLD-planning-agent.md`](HLD-planning-agent.md).
**Verified against the installed SDK**, not from memory: `langsmith 0.14.7`,
`langgraph 1.2.14`, `langgraph-cli 0.4.33`, `langchain-core 1.6.9`,
`pydantic 2.14.0`, `ortools 9.15.6755`. `openevals` is **not** installed.

Every API named below was checked to exist in this environment, except where
marked *(verify)*.

---

## 0. The whole recommendation in one table

| LangSmith surface | Verdict | One-line reason |
|---|---|---|
| **Tracing** (already wired) | **Finish it** | The trace exists; it is missing tokens, cost, and thread grouping on children. |
| **Studio + `langgraph dev`** | **Adopt now** | Free, local, and it is a real debugger for our clarify interrupt. |
| **Datasets + experiments** | **Adopt now** | The only honest way to gate changes to a deterministic solver + an LLM judge. |
| **Evaluators (offline)** | **Adopt now** | Code evaluators for `place`, a structured judge for `n_review`. |
| **Online evaluators** | **Adopt at beta** | Runs the reviewer's judgment against live plans without a re-run. |
| **Annotation queues + assertions** | **Adopt at beta** | The reviewer's rejections are exactly the thing to hand-label. |
| **Presigned feedback tokens** | **Adopt now, cheap** | A browser-side 👍/👎 on a plan with no API key exposed. |
| **Prompt Hub** | **Later, narrow** | Only worth it for the 6 stage prompts; several traps (see §5). |
| **Context Hub** | **The sleeper option** | The one versioned-artifact API that needs *no* LangChain at all. |
| **LangSmith Chat** | **Nice-to-have** | Any plan; needs a provider workspace secret. Free upside, no wiring. |
| **Alerts / webhooks** | **Later** | Needs volume to mean anything. |
| **Insights** | **Skip for now** | Plus-only, ~\$1–4 per 1,000 threads; `plan_rejects` already covers it. |
| **Engine** | **Skip for now** | Needs only traces — but it needs a *corpus* of them, and we have none. |
| **Fleet / Build tab** | **Skip** | No-code agents on Deep Agents; not our architecture. |
| **Agent Server / Deployment** | **Skip** | It is a runtime product; `apps/api` **is** our runtime. Studio only needs `langgraph dev`. |
| **Self-hosted / BYOC** | **Skip** | Enterprise + license key + we own the ops. |
| **OTel / replicas / bulk export** | **Skip** | Solutions to problems we do not have. |

The through-line: **the free tier covers everything this project actually
needs.** The paid surfaces either solve problems of scale, or run your agent on
someone else's runtime — neither is ours.

---

## 1. What we have today — the audit

`app/observability.py` and `app/llm/client.py` already do the hard part. One
turn lands as one trace:

```
plan.turn                          ← turn_trace(), carries {thread_id, mode}
└── LangGraph                      ← auto
    ├── n_intake  → llm.complete → llm.model_call
    ├── n_place                       (pure — no model call)
    └── …
```

That is a better starting point than most. Three things are missing, and one of
them is the reason cost reporting does not work at all.

### Gap 1 — the tokens are thrown away (highest-value fix in this document)

`_post()` reads `body["choices"]` and nothing else:

```python
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError(...)
```

`body["usage"]` — which DeepSeek and every OpenAI-compatible provider return —
is discarded. There is no `usage_metadata` anywhere in the seam (verified by
grep: the only match for "usage" is a `--help` string). LangSmith's cost engine
requires token counts **plus** `ls_provider`/`ls_model_name`; we already send
the latter two, so this one omission is the whole reason a trace shows no cost.

### Gap 2 — `thread_id` is on the parent only

`turn_trace("plan.turn", …, {"thread_id": thread, "mode": …})` sets thread
metadata on the turn's root run. `_llm_run()` sets `ls_provider`,
`ls_model_name`, `schema` — but not `thread_id`.

The docs are explicit that thread metadata must be on **all runs, including
children**, or thread-level filtering, thread token counts and thread cost
roll-ups silently under-report. Metadata is not inherited parent→child.
LangGraph is listed as an integration that sets `thread_id` and `ls_agent_type`
automatically, which may cover the graph run — but our hand-rolled
`llm.model_call` runs are ours to stamp. *(verify against a real trace: run one
turn, open the thread view, and check whether the LLM runs are counted.)*

### Gap 3 — thread ids are not time-sortable

Threads are `ephemeral-<uuid4>` or `conversation_<id>`. `uuid4` has no
timestamp, so sorting threads by id is arbitrary. `langsmith.uuid7` exists in
0.14.7 (verified) and embeds one. Cheap for the ephemeral form; the
`conversation_*` form is `apps/api`'s to decide.

### What is already right, and should not be "improved"

- `@traceable` gated by `tracing_enabled()` — inert with no key. That property
  is load-bearing: the offline TUI and all 72 tests run with no account.
- Metadata passed at **run creation**, not stamped afterwards. The comment in
  `_llm_run` explains why: ambient-run-tree stamping drops it on the first call
  of a turn. Keep that.
- `run_type="llm"` on the model call and `run_type="chain"` on `llm.complete`.
  This is what makes the LLM panel render with latency.

---

## 2. Tracing — the four small changes that finish it

All four live in `app/llm/client.py` and `app/observability.py`. None changes a
node, a prompt, or a contract.

**2.1 Capture usage.** Return it from `_post` and set it on the run:

```python
# in _post(): return (text, usage) instead of text
usage = body.get("usage") or {}

# inside _llm_run()'s trace(...), after creation:
run.set(usage_metadata={
    "input_tokens":  usage.get("prompt_tokens"),
    "output_tokens": usage.get("completion_tokens"),
    "total_tokens":  usage.get("total_tokens"),
})
```

`input_tokens`/`output_tokens`/`total_tokens` are the recognised field names;
`ls_provider` + `ls_model_name` are already set, so cost then computes from the
workspace pricing table. DeepSeek is not in the default pricing map — add an
entry at **Settings → Workspaces → Models** (Match Pattern is a regex against
`ls_model_name`), or set `total_cost` directly for a flat estimate. Pricing
changes do **not** backfill onto traces already logged, so add it before the
first real run.

**2.2 Stamp `thread_id` on every child.** The turn already knows the thread. The
cheapest correct fix is to set it once, ambiently, around the whole turn:

```python
with turn_trace("plan.turn", inputs, metadata) as turn:
    with ls.tracing_context(metadata={"thread_id": thread}):
        out = await graph.ainvoke(graph_input, run_config)
```

`tracing_context` "doesn't create a span itself, but initializes the context for
child spans" — which is exactly the requirement, and it removes the need to
remember it at each call site.

**2.3 Add the `core/` stages to the trace as tool runs.** `place`, `verify`,
`headroom` and `validate` are invisible today (they make no model call). They
are where the plan's dates come from, so a trace without them cannot explain a
bad plan. `n_place` in particular should be a `run_type="tool"` span carrying
its inputs (items, availability, budget) and outputs (`feasible`,
`unscheduled`, `short`, solver status) — the most useful span we could add, and
the handle the evaluators in §4 reach for via `run.child_runs`.

**2.4 Put the reject reason on the run.** `plan_rejects` rows already carry
`{intent, stage, reason, recovered}` and are returned on every result. Adding
them as `metadata["rejects"]` on the turn run makes "show me every turn where
the solver fell back" a one-line filter, and seeds the dataset in §4.

**Also worth doing, cheap:** `LANGSMITH_REVISION_ID` from the git SHA in the
Dockerfile, so every trace records which commit produced it
(`ENV LANGSMITH_REVISION_ID=$GIT_SHA`). Without it, a comparison across two
experiments cannot tell you which code each ran — and Engine reasons from this
value too.

---

## 3. Studio — the debugger we should actually use

We already have `app/studio.py`, `langgraph.json` and a README section. We are
using perhaps a third of it, and the missing third is the part that matters for
a HITL agent.

**Adopt `response_schema` on the clarify interrupt.** *(verified present in
langgraph 1.2.14: `interrupt(value, *, response_schema=None)`)*

Today `n_clarify` sends an untyped dict:

```python
answers = interrupt({
    "kind": "clarify",
    "prompt": intake.get("framing_line") or "…",
    "questions": questions,
})
```

Studio receives that as raw JSON to edit by hand. With a schema it renders
**typed input fields** instead:

```python
class ClarifyForm(BaseModel):
    answers: list[str] = Field(description="One answer per question, in order")

answers = interrupt(payload, response_schema=ClarifyForm)
```

Three things at once: the resume value is validated and coerced (an invalid
answer raises `ValidationError` and is retryable on the same thread), Studio
renders real inputs rather than a JSON blob, and `ClarifyQuestion`'s contract
stops being advisory on the UI side. One line, real value. This is the single
best Studio feature for this agent.

**Use the debugger for the review loop.** Studio's breakpoints (Interrupt →
choose node → pre/post → Continue) and "Edit node state → Fork" let us re-run
placement from a checkpoint with one edited state key — precisely the loop the
HLD argues about at §8.6. Today that means writing a throwaway script.

**Two operational notes that will bite otherwise:**

- `langgraph dev` state is **in-memory and pickled locally** — lost on restart,
  and watch-mode reloads interrupt sessions. That is fine, and is the point
  (Studio stays a scratch surface next to the real Postgres store in
  `apps/api`) — but do not debug a long clarify chain expecting it to survive an
  edit.
- Safari and Brave cannot reach `localhost` from Studio, and **Chrome 142+**
  needs the site's "Local network access" set to Allow. `--tunnel` exists and is
  documented as unreliable. Our README should carry the Chrome note: it presents
  as a broken graph, not a browser permission.

**Do not adopt `langgraph up` or any hosted deployment.** The Agent Server is a
runtime product that executes graphs on its own workers; `apps/api` imports the
graph in-process and *is* the runtime. Cloud needs Plus (\$39/seat); self-hosted
needs Enterprise plus a license key and beacon egress. Nothing on our roadmap
needs a second runtime.

---

## 4. Evaluation — the part that changes how we work

The largest genuine capability gain, and it is free.

Evaluation in LangSmith is framework-agnostic by construction: a target is just
`inputs: dict -> dict`, and "usage of LangChain is totally optional". Our
`complete` seam, the `core/` purity test, and the injection seam mean we can
build a real harness without touching production code.

Be precise about *what* to evaluate, though, because our architecture splits the
problem in two and the halves need different machinery.

### 4.1 The solver — code evaluators, exact assertions

`place` is deterministic (`numWorkers=1`, integer tenths of an hour). A
deterministic function is the easy case: assert exact equality, no judge, no
variance. Seed a dataset of real constraint sets and assert the properties the
HLD already claims and `tests/unit/test_core.py` checks offline:

| evaluator | assertion |
|---|---|
| `no_capacity_violation` | `Σ_t h[t][d] ≤ cap[d]` for every day |
| `shared_budget_held` | weekly sum across **all** goals ≤ the user's budget |
| `nothing_dropped` | every input item is placed or explicitly `unscheduled` |
| `determinism` | two runs on identical input yield identical slots |
| `objective_not_regressed` | weighted coverage ≥ the recorded baseline |

This is the regression harness the HLD asks for at §15 — with history in
LangSmith instead of a pass/fail that scrolls away.

### 4.2 The reviewer — a structured judge over `PlacementCritique`

`n_review` is the judgment call: sequencing, load, rhythm, absurdity. It returns
a Pydantic model, and it is the model's only lever on placement. Two shapes fit,
and we want both.

**A code evaluator that reads the critique the run already produced** — accepts
`run: Run` / `example: Example` and asserts
`outputs["critique"]["ok"] == reference_outputs["expected_ok"]`. Cheap, no extra
model call, and it scores the reviewer against a hand-labelled set.

**An LLM judge on the placement itself**, using our own `complete` seam with a
Pydantic output schema so the verdict is structured, not prose. But the right
*key* is not "is the plan good". Our system already requires a rejection to
carry `ConstraintDelta[]` or be coerced to `ok=True`. So the failure mode worth
measuring is:

> **Did the reviewer reject anything it could not express as a delta?**

That is the failure that silently degrades the review loop, it is observable
from the run alone, and it maps onto the HLD's own invariant at §7. Give it a
dedicated feedback key (`review_delta_expressible`) and alert on drift.

### 4.3 The whole turn — a small golden set per intent

`intake → plan → decompose → propose` produce meaning, and meaning has no
reference answer. Use LangSmith's **assertions** for this rather than
exact-match: a reviewer writes claim-level checks — `must_ask_about_hours`,
`must_not_place_final_mock_first`, `must_name_a_phase` — which land in the
example's `outputs.assertions`, and one evaluator grades them all:

```python
def grade_against_assertions(outputs: dict, reference_outputs: dict) -> list[dict]:
    """One feedback score per assertion, keyed by the assertions themselves."""
    return [
        {"key": a["key"], "score": check(outputs, a)}
        for a in reference_outputs.get("assertions", [])
    ]
```

Assertions are a UI concept (run items in single-run queues only — not thread
items, not pairwise queues), so they need a human in the loop at least once. The
docs' own guidance: 5–10 examples per critical component, then 10–20 curated.
Keep it small; `agentevals`-style trajectory checks are worth adding only if
node *order* itself turns out to matter.

### 4.4 Wiring it

```bash
uv pip install --python .venv/bin/python -e ".[dev,eval]"
```

Add an `eval` extra to `apps/agent/pyproject.toml` beside `dev`. Then:

- `scripts/seed_datasets.py` — builds the three datasets programmatically
  (`create_dataset` + `create_examples`), `metadata={"kind": …}`, a `test` split
  so CI can pin a version (`update_dataset_tag(..., tag="prod")` before a
  release, `list_examples(as_of=…)` after).
- `tests/eval/test_solver.py` — `aevaluate(solver_target, data=…,
  evaluators=[…])`, all code, no LLM.
- `tests/eval/test_review.py` — the judges.
- Set `LANGSMITH_TEST_CACHE` to a checked-in cassette directory so CI replays
  the judge instead of re-billing it. This is the difference between a CI gate
  and a CI bill.

**Gate, don't admire.** The docs' own recipe: run `evaluate(..., blocking=False)`,
aggregate `result["evaluation_results"]["results"][0].score`, `sys.exit(1)`
below threshold. An experiment nobody gates on is a dashboard; a threshold is a
decision.

`openevals` ships ready-made judge prompts (`PLAN_ADHERENCE_PROMPT`,
`CORRECTNESS_PROMPT`, `HALLUCINATION_PROMPT`, and a `LAZINESS_PROMPT` that is
temptingly relevant to a planner). Not installed; a small optional add **after**
the harness exists. Do not start there.

One trap: **dataset-bound UI evaluators run automatically alongside your
`evaluators=[...]` list**, so a judge configured in the UI will quietly run on
every SDK experiment.

### 4.5 Online evaluators — for the review loop, at beta

Offline eval answers "did this change make the planner worse". Online
evaluation answers "is the planner making sense on real turns, right now". For
us: an online evaluator on `n_review`'s output, filtered to rejected turns,
sampled.

Two documented traps:

- Online evaluators **auto-upgrade the scored trace to extended retention** — a
  billing event per trace. Deliberate is fine; unaware is not.
- Thread-level (multi-turn) evaluators require a top-level `messages` key in
  every trace's inputs/outputs, project-level idle time, runs under a week old,
  and cap at 500 threads per execution. Our state is `PlanState`, not messages,
  so a thread-level evaluator needs a translation layer. Run-level is the honest
  first step.

### 4.6 Real user feedback — the cheapest signal we are throwing away

`apps/api` already exposes `/tools/confirm` and `/tools/reject`. A user
accepting or rejecting a proposal **is** a feedback signal, and LangSmith never
sees it.

Two mechanisms, and the second is the better one for us:

**Server-side**, from the route that already knows the run:

```python
client.create_feedback(key="proposal_confirmed", score=1,
                       run_id=run_id, session_id=session_id)
```

`session_id` is required; when `trace_id=` is passed the Python SDK backgrounds
the call, so it does not sit in the user's request path.

**Browser-side, via a presigned token** — this is the one that fits our UI. Mint
a token when the plan is returned and put the URL in the response:

```python
token = client.create_presigned_feedback_token(
    run_id, feedback_key="plan_helpful",
    expiration=timedelta(hours=24),
    feedback_config={"type": "continuous", "min": 0, "max": 1})
# → token.url, POSTable from the browser, no API key exposed
```

`create_presigned_feedback_tokens(run_id, feedback_keys=["thumbs_up",
"thumbs_down"])` does a pair in one call (Python-only). Default expiry is 3
hours; give it 24. The unauthenticated POST accepts `score`, `value`, `comment`,
`correction` and `metadata` (GET accepts no metadata). One caveat: presigned-URL
feedback **always** extends a base-retention trace to extended retention, with
no opt-out — the opposite of manual UI adds, which do not.

**Feedback configs** give the keys a shape before anything writes them:
`create_feedback_config("plan_helpful", feedback_config={"type": "continuous",
"min": 0, "max": 1}, is_lower_score_better=False)`. Note it is create-or-conflict:
an identical config returns the existing one, a *different* config for the same
key is a 400.

**Annotation queues** are where a human labels the reviewer's rejections — which
is how the §4.2 judge gets a reference set instead of us inventing one. Rubric
items are `feedback_key` + description + `score_descriptions` /
`value_descriptions`. Two gotchas: `update_annotation_queue` **replaces the
entire rubric list** (omit an item and it is deleted), and a single add action
caps at **100 runs**.

---

## 5. Prompt Hub — later, and with three traps

We have six prompts in `app/prompts/__init__.py`, as Python f-strings with
`{today}`, `{availability}`, `{rows}` slots. `Client.push_prompt`,
`pull_prompt`, `create_commit` and `list_prompts` all exist in 0.14.7
(verified). The real win would be editing `REVIEW`'s prose without a deploy, and
getting a commit hash to pin in an experiment's metadata.

Why not now — three concrete traps, all of which would cost a debugging session:

**1. `pull_prompt` returns a LangChain object.** The ergonomic SDK path is not
LangChain-free. The documented ways to render a pulled prompt into a payload our
httpx client could send are `convert_prompt_to_openai_format` /
`convert_prompt_to_anthropic_format` (which need `langchain_openai` /
`langchain_anthropic`) — or raw REST, `POST /api/v1/prompts/invoke_prompt` with
`{messages, template_format, inputs}`, which renders server-side and needs no
LangChain at all. Pushing from plain Python means hand-building the manifest and
`POST /api/v1/commits/{owner}/{repo}`.

**2. f-string parses our JSON schema's braces as variables.** In f-string
format a `{` starts a variable, so a template carrying `model_json_schema()`
must escape every brace to `{{`/`}}`; mustache treats a lone `{` as literal.
Today this is *not* a problem, and it is worth knowing why: the node formats the
prose template first, and `_prompt_with_schema()` appends `schema_brief(schema)`
afterwards — the schema is never a template variable. The hazard appears the
moment the schema moves *into* the stored template, which is exactly what
`StructuredPrompt.from_messages_and_schema(messages, schema=…model_json_schema())`
does — the otherwise natural fit for our one-Pydantic-model-per-stage design. If
we adopt that, the format must be mustache.

**3. f-string also silently rejects dot notation, format specs, expressions and
indexing** — `{user.name}`, `{price:.2f}`, `{items[0]}` all become literal
variable names rather than errors.

Also: prompt caching is **on by default** in this SDK version (300 s TTL, 60 s
refresh, a process-global singleton), so an edit may not be visible immediately —
`pull_prompt(..., skip_cache=True)` when you need the newest commit.

The better-shaped option for us is **Context Hub** (`push_agent` / `push_skill`,
`langsmith >= 0.7.35`, so 0.14.7 qualifies). Its `files` argument is a plain
`dict[str, FileEntry]` of strings — no LangChain types anywhere — which makes it
the **only versioned-artifact API in LangSmith we could drive with just the SDK
we already have**. It is designed for `AGENTS.md`/`SKILL.md` bundles, and it
would version our prompt prose plus the contract shapes as one immutable commit
with a hash to pin in experiment metadata. Worth a look when prompt editing
becomes the bottleneck; neither option is worth doing before §2 and §4 are
done, because the prompts are not what changes most — the shapes are, and
`schema_brief()` already injects the live schema so the model is never guessing.

---

## 6. What to skip, and why

| Skipped | Why |
|---|---|
| **Agent Server / cloud deployment** | A second runtime for a library already imported in-process. Plus \$39/seat. |
| **Self-hosted / BYOC** | Enterprise + license key + beacon egress + we own upgrades, scaling, backups. |
| **RemoteGraph** | Solves a network hop we do not have, and carries a documented deadlock warning when pointed within one deployment. |
| **MCP / A2A endpoints** | Genuinely zero-effort capabilities — *of the Agent Server*. Nothing exposes us as an agent to third parties. |
| **Insights** | Plus-only; needs a separate model configuration; ~\$1–2/1,000 threads (OpenAI) or \$3–4 (Anthropic); up to 30 min per report. `plan_rejects` already gives per-stage reject rate. |
| **Engine** | It needs *only* traces — no deployment, any plan, org-admin opt-in — but it clusters a **corpus** of production failures, and we have no production traffic yet. It also bills in LSU (\$1 each) with a 750/month default cap. Revisit with real traffic and a repo connected; note its scope filters are narrow (Run Name and Metadata, at most two conditions). |
| **Fleet / Build tab** | No-code agents on Deep Agents with channels and computer use. Not our architecture; computer use needs Plus. |
| **Agent-based workspaces** | Beta, enabled per org; splits tracing by Production/Staging/Development/Local via `LANGSMITH_AGENT_ID` + `LANGSMITH_AGENT_ENVIRONMENT`. Interesting for environment separation later; mutually exclusive with project addressing, so it is a migration, not a toggle. |
| **LangSmith Chat** | Free upside, no wiring — it reads traces and can add failing runs to a dataset. Just needs a provider key stored as a workspace secret. Try it before building anything. |
| **OTel / replicas / bulk export / distributed tracing** | Distributed tracing unifies a *network hop* between services. Ours is a function call. |

---

## 7. Cost and plan

- **Developer (\$0, 1 seat)** covers everything in §2–§4: 5k base traces a
  month, 14-day retention, datasets, experiments, evaluators, annotation queues,
  Studio. Datasets have **indefinite** retention even on the free tier — the
  seed corpus is the durable asset, and it does not expire with the traces. That
  is the single best argument for building §4 early.
- Base retention is **14 days**; extended is 180 and costs more. Turning on
  online evaluators silently upgrades the traces they score. Before beta, 14
  days is fine.
- The boundary that will actually bite: **1 seat**. Annotation queues are a
  collaborative surface, and the moment a second person needs to label, this is
  Plus (\$39/seat). Worth knowing before inviting someone.
- The only recurring LLM spend we would add is the offline judge (§4.2), and
  `LANGSMITH_TEST_CACHE` is how we keep it out of CI.

---

## 8. How this changes how we plan the agent

A few things the docs imply about agent structure, worth stating because they
cut against instinct:

1. **This is a documented workflow, not a free-running agent** — and the docs'
   own over-engineering warnings back the 11-node shape. Nothing in LangSmith
   rewards making it more agentic; tracing, evaluation and Studio all work
   *better* on a graph with named nodes, because that is what gives them
   handles. Keep the node granularity.
2. **Node names and state keys are a public API.** The newest graph runs against
   oldest checkpoints, and evaluators, dashboards and Engine filters all key on
   node names and metadata. A rename breaks more than the code. HLD §11.1
   already says this; LangSmith makes it concrete and adds a consumer.
3. **The evaluator is where the design gets tested.** The review loop's contract
   — *a rejection must carry a delta* — is the most consequential rule in the
   design, and §4.2 gives it a metric. Healthy metric ⇒ CP-SAT convergence is
   real; drift ⇒ the loop is spinning.
4. **Deterministic halves want assertions; LLM halves want judges.** Splitting
   the harness along the HLD's own meaning/dates boundary is not a convenience —
   it is the same boundary the architecture already enforces.
5. **Cheap tracing now, good datasets later, prompts last.** The dataset is the
   asset that appreciates; the prompt version is the one that goes stale.

---

## 9. Sequenced roadmap

Each step is independently shippable.

| # | Step | Where | Cost |
|---|---|---|---|
| 1 | Capture `usage_metadata`; stamp `thread_id` on children; add `revision_id` | `app/llm/client.py`, `app/observability.py` | ~30 lines, no deps |
| 2 | Add `core/` stages to the trace as `tool` runs (`n_place` first) | `app/graph/build.py` | ~20 lines |
| 3 | `response_schema` on the clarify interrupt | `app/graph/nodes.py` | 1 schema + 1 kwarg |
| 4 | Presigned feedback token + `create_feedback_config` on the plan response | `apps/api/sutra_api/api/plan.py` | ~10 lines |
| 5 | Seed datasets from `plan_rejects` + hand-labelled turns | `scripts/seed_datasets.py` | new file |
| 6 | Solver evaluators + CI gate | `tests/eval/test_solver.py` | new file, no LLM |
| 7 | Reviewer judge + `review_delta_expressible` key | `tests/eval/test_review.py` | needs a judge key |
| 8 | Online evaluator on rejected turns | LangSmith UI | sampled, beta |
| 9 | Context Hub or Prompt Hub, if prompt edits become the bottleneck | — | deferred |

Steps 1–4 are the ones that pay for themselves immediately. **Step 1 is the only
one where the current state is actively wrong rather than merely incomplete.**

---

## 10. Open questions to verify against a real trace

Listed because the docs disagree with themselves or do not say, and each answer
changes what we build:

1. Does LangGraph's auto `thread_id` cover our hand-rolled `llm.model_call`
   runs, or do they need §2.2? *(The trajectory-integration page claims
   LangGraph sets it; the threads page says every run needs it.)*
2. Does DeepSeek's `usage` block use the field names the cost engine expects
   (`prompt_tokens` / `completion_tokens`)? Check one real response.
3. Can DeepSeek pricing be registered at all, given the docs say pricing changes
   do not backfill onto already-logged traces?
4. Does `response_schema` on `interrupt()` round-trip through Studio's form and
   back into `ClarifyQuestion`'s shape cleanly, given the graph keys answers
   positionally?
5. If we ever push a schema-carrying prompt, does Studio's Playground preserve
   the mustache braces, or does a round-trip through the UI re-escape them?
