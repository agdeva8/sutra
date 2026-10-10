# Sutra planning agent

A LangGraph agent that turns one sentence ("switch jobs in 3 months") into a
dated plan across five horizons, and keeps that plan true as the user's
circumstances change.

Design: [`docs/architecture/HLD-planning-agent.md`](../../docs/architecture/HLD-planning-agent.md).

## Run it

```bash
cd apps/agent
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python ortools langgraph langgraph-checkpoint-postgres \
    pydantic pydantic-settings fastapi uvicorn pytest pytest-asyncio

# the terminal UI — no network, no database required
.venv/bin/python -m app.tui
```

Then either type a message, or run `/demo` to walk every functionality at once.

## The terminal UI

| Command | What it shows |
|---|---|
| `/demo` | all seven behaviours in one run — plan, clarify, resume, slim replan, escalated replan, staleness, renegotiation |
| `<message>` or `/plan <message>` | plan a goal end to end |
| *a bare line while a question is open* | answers it — type a number to pick an option, or your own words |
| `/answer` | re-show the pending question |
| `/replan <action>` | report a change and see which tier it lands in — try `daily_log`, `blocker.add`, `goal.edit`, `goal.dates`, `milestone.edit` |
| `/staleness` | the refresh-button count and the toaster strings |
| `/deltas` | the constraint deltas currently applied to the solver |
| `/rejects` | the per-stage rejection log |

With no `SUTRA_LLM_API_KEY` set, the agent uses a deterministic rule-based stub,
so every path runs offline. Set `SUTRA_LLM_API_KEY` (and optionally
`SUTRA_LLM_BASE_URL`, `SUTRA_LLM_MODEL`) to use a real OpenAI-compatible model —
nothing else changes.

For DeepSeek: `DEEPSEEK_API_KEY` plus `DEEPSEEK_API_URL=https://api.deepseek.com`,
and `DEEPSEEK_MODEL` if the default (`deepseek-chat`) is not the one you want.
Check the wiring before trusting it — this prints the endpoint, the model, and
whether each stage actually returns schema-valid JSON:

```bash
.venv/bin/python -m app.llm.client --check
```

### The model boundary

Two bases, because two different things are being validated. `_Strict`
(`extra="forbid"`) is for models we construct and for solver I/O — an unexpected
key there is our own bug. `_Llm` (`extra="ignore"`) is for models the model
fills, and it absorbs the fields a real model volunteers: `confidence`,
`reason`, `next_action`, `{"key": …, "reason": …}` where a string was asked for,
a missing `id` on a question. Rejecting the whole response over those is a
reliability bug, not rigour.

The prompt carries the real JSON schema (`model_json_schema()`, compacted), so
the model is told the shape instead of guessing it, and a failed parse gets one
repair round-trip carrying the validation error back.

## Watching it work (LangSmith)

Optional, and off unless you ask for it. With a key set, one turn lands as one
trace — the parent `plan.turn`, every node under it, and every model call:

```
plan.turn
└── LangGraph
    ├── n_intake        → llm.complete → llm.model_call  (IntakeSpec)
    ├── n_plan          → llm.complete → llm.model_call  (PlanSpec)
    ├── n_lattice       (pure — no model call)
    ├── n_decompose     → llm.complete → llm.model_call  (DecomposeSpec)
    ├── n_place         (CP-SAT — no model call)
    ├── n_verify        (pure)
    ├── n_review        → llm.complete → llm.model_call  (PlacementCritique)
    ├── n_headroom      (pure)
    ├── n_propose       → llm.complete → llm.model_call  (ReplanAction)
    └── n_validate      (pure)
```

```bash
export LANGSMITH_API_KEY=lsv2_pt_…
export LANGSMITH_PROJECT=sutra-agent   # optional
```

A key is enough — `app/observability.py` sets the env spellings LangGraph and
the LangSmith client each read, so there is no config file to keep in sync.
`LANGSMITH_TRACING=false` is the explicit opt-out.

Each `llm.model_call` carries `ls_provider`, `ls_model_name` and the schema
name, so the trace tells you which stage produced which call. Those come from
`app/llm/client.py`, not from LangChain: the provider speaks the OpenAI wire
format over httpx, and without that instrumentation the model calls — the
expensive part — would be the one thing missing from the trace.

The TUI prints the trace URL under every result, and `/provider` shows whether
tracing is on.

## Layout

```
app/
  core/        PURE — no DB, no network, no LLM client
    util         date math, UTC-only
    lattice      phase spans, milestone dates, week bands, the 20% buffer
    place        the OR-Tools CP-SAT model — the only writer of dates
    fallback     structural placement — the only fallback
    headroom     capacity gate
    validate     placement invariants + action grounding
    staleness    blast radius, tier, the toaster strings
  contracts/   every pydantic model — the source of truth for every shape
  prompts/     one prompt per LLM stage — prose, not shapes
  graph/       the LangGraph StateGraph (11 nodes, 1 entry point)
  llm/         the one LLM seam
  observability  LangSmith tracing — opt-in, inert when unconfigured
  tui.py       the terminal UI
```

The agent is a **library**: it exposes no HTTP surface of its own. `apps/api` is
the one service `apps/web` calls, and it serves the planner routes by importing
this package in-process. The product's HTTP contract lives in
[`apps/api/openapi.yaml`](../api/openapi.yaml).

## The rules the code enforces

These are checked in code, not trusted to a prompt:

- **The LLM never supplies a date for a task.** `DecomposeStep` and
  `MilestoneSpec` reject any date-shaped key (`date`, `start_date`,
  `target_date`, `scheduled_for`, …). Everything else the model volunteers is
  ignored, not fatal — see the boundary note below.
- **A material unknown forces a clarifying question.** `IntakeSpec` will not
  validate a material unknown with no question: it synthesises one.
- **A rejection must carry constraint deltas.** `PlacementCritique` coerces a
  bare `ok=False` to `ok=True` — because CP-SAT is deterministic, a rejection
  with no deltas cannot change the answer, so it is not a rejection.
- **No model or solver failure ever 500s.** Every stage degrades; worst case is
  `no_change` with a `plan_rejects` row. Programmer errors still propagate.
- **`core/` imports nothing from `store`, `llm`, `graph` or `api`** — asserted
  by a test, not by convention.

## Tests

```bash
.venv/bin/python -m pytest tests/unit -q
```

72 tests, no network and no database. The load-bearing ones assert the shared
weekly budget across goals, placement reproducibility, that a task is never
dropped, that a step longer than a day gets split, that the review loop
converges, and that a clarifying answer reaches the plan stage rather than only
intake.

`tests/unit/test_contracts.py` is the model boundary, and every payload in it is
one a real model actually returned — the verbatim DeepSeek response that failed
with 23 validation errors is the first test in the file.

## Known gaps

- **No persistence yet.** `store/` and the FastAPI routes are not written; the
  TUI holds session state in memory and the graph uses an `InMemorySaver`.
  Postgres checkpointing and the API surface are the next slices (HLD §11, §17).
- **`n_review` never sees the plan's prose or the user's rhythm preferences** —
  it reviews dates against availability only. Feeding it the plan narrative is
  a small follow-up.
- **Time-of-day is out of scope.** The solver places a task on a *day*; Time
  Blocks are a separate layer needing a time-window availability model.
