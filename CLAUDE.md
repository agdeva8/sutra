# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Sutra / GoalCoach v2 — a planning agent that turns "switch jobs in 3 months" into a dated, multi-horizon plan and keeps it true as circumstances change. This is the `develop_v2` worktree: a fresh, Python-only rewrite of a v1 that existed as a TypeScript Next.js app plus a Python port.

| Path | What it is |
|---|---|
| `apps/agent/` | **The planner — a library, not a service.** Python + LangGraph + OR-Tools CP-SAT. No HTTP surface. |
| `apps/api/` | **The only HTTP surface.** FastAPI; serves `/plan/*` by importing `apps/agent` in-process. |
| `apps/storybook/` | Standalone Storybook (React 19 + Vite) used as a UI harness to click through the app and file bugs. |
| `docs/architecture/HLD-planning-agent.md` | The design of record for the planner: the graph, the invariants, the failure ladder. Read it before changing planning behaviour. |
| `apps/api/openapi.yaml` | The product's HTTP contract (47 routes). |
| `apps/api/CONTRACT-RECONCILIATION.md` | **Authoritative over `openapi.yaml`.** 39 shapes in the spec disagree with the app it claims to be derived from; this file resolves all 70 individually and says which way each went. Several corrections look wrong to a well-meaning reader and get "fixed" back to the broken state. |
| `apps/web/`, `packages/*`, `tests/`, `supabase/`, `scripts/` | Empty placeholders. `apps/api` is imported in-process, so `packages/` does not exist yet. |

There are **no linters configured** (no ruff, mypy, eslint, or pre-commit). Do not claim a lint pass.

## Design principles

**1. Structure the code, but never slow the MVP to do it.** Neat, modular code: a class or function wherever one gives the thing a real shape, docstrings and comments on the non-obvious parts (the *why*, not the *what* — this codebase's existing docstrings are the standard to match). Reach for the right abstraction when it exists. But structure is in service of shipping: do not gold-plate, do not split a module into five for symmetry, and do not hold a feature back to refine its shape. Prefer the simple version that works, then improve it when the feature is settled.

**2. Tests do not gate progress. Unit tests are written at commit time.** While a feature is being built, do not stall on testing — the bar is "does this actually work when I run it", checked the normal way (run it, hit it, print it). Unit tests are written when the user says to commit the feature: at that point write the UTs, run the suite, and fix what they surface. This is a deliberate ordering, not an omission — the structure settles first, then the tests pin it. Do not refuse to proceed, or pad a response with "I should also add tests", when the user has not asked for them yet.

The existing suites and the `pytest tests/unit` commands below are still the right thing to run **when** you are in that test-writing phase, and a test that already exists should be kept green — this principle is about not *front-loading* test work, not about letting a broken suite stand.

**3. No magic values. Write it the way production code is written.** Anything that could plausibly change — a model id, a URL, a path, a limit, a timeout, a prompt, a tool list, a default — gets a name and a home, and the code refers to the name. Inline literals at the point of use mean that changing that one thing becomes a hunt through the codebase.

```python
# No — every value buried at the call site.
agent = create_agent(
    model="openrouter:anthropic/claude-sonnet-4-6",
    tools=[get_weather],
    system_prompt="You are a helpful assistant",
)

# Yes — the shape is the same, the values have names and a home.
# config.py
DEFAULT_MODEL = "openrouter:anthropic/claude-sonnet-4-6"
TOOL_REGISTRY = {"get_weather": get_weather}
# prompts/system.py
SYSTEM_PROMPT = """You are a helpful assistant."""
# call site
agent = create_agent(
    model=settings.model or DEFAULT_MODEL,
    tools=resolve_tools(settings.enabled_tools),
    system_prompt=SYSTEM_PROMPT,
)
```

This codebase already works this way and the pattern is to be followed, not reinvented: every tunable lives in a settings object (`apps/api/sutra_api/config.py`, `apps/agent/app/llm/client.py`), prompt prose lives in its own module (`apps/agent/app/prompts/`) rather than inline in a node, and shapes live in `contracts/schemas.py`. Model ids and endpoints come from the environment, never from a literal in a function body.

The judgement call is *what counts as a value worth naming*: a number or string that carries meaning (a cap, a default, a model name, a route prefix) is a constant; `0`, `1`, `""`, `True` used structurally, and one-off arithmetic inside a pure function, are not. Name it when a reader would otherwise have to guess why it is that number, or when changing it is a real possibility.

**4. When the network or the sandbox blocks a step, hand it to the user — do not grind.** Network reachability here is *flaky, not fixed*. `pypi.org` timed out on four separate attempts over most of an hour and then installed normally, with no change to the command, no proxy, and no config edit. A connectivity failure is therefore **not** evidence that a host is blocked, and "this environment cannot reach X" is almost always a wrong conclusion drawn too early.

So: **two failed attempts is the limit.** If a command fails twice on a network or sandbox cause, stop retrying, say plainly what is blocked and what it is blocking, and give the user a copy-pasteable script or a numbered set of steps to run in their own terminal — in a `bash` fenced block, so it can be run directly. Then continue with whatever part of the task does not depend on it, or wait. Do not burn turns re-running the same command with different flags, and do not silently work around a blocked dependency by substituting something the user did not ask for.

Recognise the failure as a blocker rather than a bug: connection timeouts, `curl` exit code `000`, `Failed to fetch` from `uv`/`pip`/`npm`, `Operation not permitted` on a socket, and DNS failures. A missing file or a bad argument is a bug — fix it. A blocked host is the user's to unblock.

**5. Build from the core outward, and check in before wrapping.** Prove the innermost thing works before building anything on top of it, then let the user confirm before you start wrapping it up. Every layer is verified before the next one is built on it, so a wrong foundation is caught while it is still one small piece rather than at the end of a large structure.

The order for anything with an external dependency, on the user's own example:

1. **Reachability first** — confirm the API / MCP / database actually responds before writing a line of client code. Nothing below this matters if the host is unreachable.
2. **The raw call** — a method that makes the request and parses the response into the shape the codebase uses.
3. **The client** — the wrapper that uses that call: retries, auth, error mapping, the interface the rest of the app sees.
4. **The layer above** — the route, node, or component that consumes the client.

**Then stop and show the user before wrapping up.** Surface the smallest thing that demonstrates the real behaviour — the core working end to end — and let them confirm the shape before it is built on. Do not disappear for a long build and return with a large finished structure the user has never seen: if the core is wrong, everything wrapped around it is rework.

This is the same instinct as principle 1 and it is not an excuse to stop early: the core is proven *working*, not sketched, and "check in" means showing real output, not a plan.

**6. Do not set limits conservatively. Loosen them, and fix what breaks.** Caps, timeouts, retry counts, batch sizes, page limits, `max_tokens`, truncation lengths, rate limits, and cache sizes should be set generously enough that the thing actually works on real input — not tuned down to a number that feels safe. An over-cautious limit is a bug that hides: it does not fail loudly, it silently truncates, silently drops the last page, silently times out a solve that would have finished, and the symptom shows up far from the constant that caused it.

Set the limit where the feature genuinely needs it, ship it, and let real errors tell you where the ceiling belongs. Tighten a specific limit when there is a concrete failure pointing at it — a timeout with evidence the work needs longer, a payload that is genuinely too large — not preemptively because a large number looks risky.

Two things this does **not** mean:

- **It is not licence to remove a limit that exists for a real reason.** A cap that protects a shared budget, bounds an unbounded solver search, or stops a retry loop from spinning forever (`MAX_CLARIFYING_ROUNDS`, `n_place`'s `TimeoutPolicy`, `numWorkers=1`) is load-bearing — the answer there is a *generous but finite* value, not `None`. Principle 5's "each layer verified" still applies: bounds come from observed behaviour, not from optimism.
- **It is not a reason to leave a failure unhandled.** Loosening the limit does not excuse skipping the degradation path — the failure ladder still stands, so a timeout that does eventually fire still has somewhere sane to go.

## Commands

### `apps/agent` — the planner library

```bash
cd apps/agent
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python ortools langgraph langgraph-checkpoint-postgres \
    pydantic pydantic-settings fastapi uvicorn pytest pytest-asyncio
```

```bash
cd apps/agent && .venv/bin/python -m pytest tests/unit -q
```

Single test: `.venv/bin/python -m pytest tests/unit/test_core.py::test_place_never_exceeds_capacity -q`

```bash
cd apps/agent && .venv/bin/python -m app.tui          # terminal UI; /demo walks every behaviour offline
```

```bash
cd apps/agent && .venv/bin/python -m app.llm.client --check   # prints endpoint, model, per-stage JSON validity
```

With no `DEEPSEEK_API_KEY`/`SUTRA_LLM_API_KEY`, every stage falls back to a deterministic rule-based stub, so the whole thing runs with no network and no credentials. This means a broken model wiring is **indistinguishable from a working one** until you read the output — check it explicitly when a plan looks too tidy.

Studio (`langgraph dev`, port 2024 → LangSmith Studio) is a scratch surface: `apps/agent/app/studio.py` is the only thing it imports, and no production path goes through it. Install with `uv pip install --python .venv/bin/python "langgraph-cli[inmem]"`, then `.venv/bin/langgraph dev`. The input **is** `PlanState` — paste `studio_input.json` first.

### `apps/api` — the service

```bash
docker compose -f infra/docker-compose.yml up -d     # Postgres on 5433, NOT 5432
```

```bash
cd apps/api && uv venv --python 3.14 .venv && uv pip install --python .venv/bin/python -e ".[dev]"
```

```bash
cd apps/api && set -a; source .env; set +a && .venv/bin/alembic upgrade head
```

There is no hand-written first migration — `models.py` is the schema of record, so the initial revision comes from `alembic revision --autogenerate`.

```bash
cd apps/api && .venv/bin/uvicorn sutra_api.main:app --reload --port 8000
```

```bash
cd apps/api && .venv/bin/python -m pytest tests/unit -q
```

### `apps/storybook`

```bash
cd apps/storybook && pnpm install && pnpm storybook    # port 6007, not Storybook's usual 6006
```

```bash
cd apps/storybook && pnpm build-storybook
```

### Tests

Per design principle 2, new unit tests are written when the user asks to commit a feature — they are not a gate on mid-feature progress.

Both apps default `pytest` to `tests/unit`, and that suite imports only pure modules: no database, no network, no credentials. Integration tests hit a **shared** Supabase/Postgres, so they are opt-in — running `pytest tests` (not `tests/unit`) writes to the served database. There is no fixture that fakes Postgres: the schema uses `JSONB` and `ARRAY`, which SQLite cannot express, so any DB test uses the real Docker Postgres.

`apps/agent/tests/unit/test_purity.py` mechanically asserts that `app/core/` imports nothing from `store`, `llm`, `graph`, `api`, `psycopg`, `httpx`, `fastapi`, or `langgraph`.

## Architecture

### The one locked boundary

> **The LLM owns meaning. Code owns dates.**

The LLM decides goal title, phases, milestone titles, weekly step content, and prose. Code decides phase spans, milestone dates, week bands, the 20% buffer, and which day each step lands on. `app/core/place.py` is the **only writer of `plan_items` dates**; a step whose date the model chose is a bug, not a fallback. The schemas enforce this with a date-*key* check (`date`, `start_date`, `due_date`, `target_date`, `scheduled_for`, …) on `DecomposeStep` and `MilestoneSpec` rather than an all-or-nothing `extra="forbid"`.

There is deliberately no "quick LLM first pass, solver only if needed" path — a first pass that emits dates is the same bug with an extra step.

### One graph, one write path

Planning and replanning are the *same* compiled graph, entered with a different intent. `apps/agent/app/graph/build.py` builds it; 12 nodes, one entry point, in `nodes.py` with routers in `routers.py`:

```
n_intake → n_plan → n_lattice → n_decompose → n_place
        → n_verify → [n_review ⇄ n_place] → n_headroom → n_propose → n_validate → END

any of  n_intake | n_plan | n_decompose | n_review | n_propose
        → n_clarify (the one interrupt) → resume at the node the origin declared
```

`n_clarify` is a **hub, not a stage**: any model stage that finds a material unknown writes a `clarify_request` and its router diverts there. No stage calls `interrupt()` itself — LangGraph re-executes a node from its first line on resume, so an interrupt after a model call would replay that call. The origin's `resume` target is a **code constant**, never model output, which is what keeps the control flow predetermined (the model may divert, never choose a destination).

Two structural rules make it work:

- **Every router reads `state["result"]` first and routes to `END` if it is set.** A node signals "the turn is over" by writing `result`; the turn then ends cleanly. This is what makes "never fail the user's action" structural rather than defensive.
- **`n_verify` and `n_validate` are two entries into the same pure module** (`core/validate.py`) — placement invariants before the semantic review, action grounding after the proposal. `n_place` is re-entered, never duplicated, when `n_review` rejects.

`n_place` is the only node with a `TimeoutPolicy` — the CP-SAT search is the only unbounded work. It runs `numWorkers=1`: a plan must be reproducible, and a deterministic solver is worth more than a fast one.

### Failure ladder

**No model or solver failure ever 500s.** Every stage degrades; the worst case is `no_change` with a `plan_rejects` row. Programmer errors still propagate loudly. HLD §13 is the full table — read it before adding an error handler.

### Contracts and the model boundary

`apps/agent/app/contracts/schemas.py` is the single source of truth for every shape. There are **two base models and the distinction is load-bearing**:

- `_Strict` (`extra="forbid"`) — for models we construct and for solver I/O. An unexpected key there is our own bug.
- `_Llm` (`extra="ignore"`) — for models the *model* fills. A real model volunteers `confidence`, `reason`, `next_action`, `{"key": …, "reason": …}` where a string was asked for, and omits question `id`s. Rejecting the whole response over those is a reliability bug, not rigour — the first real DeepSeek run produced 23 validation errors and the agent could not plan at all.

Two consequences that look like leniency but are not:

- The prompt carries the real JSON schema (`model_json_schema()`, compacted) so the model is told the shape instead of guessing it, and a failed parse gets one repair round-trip carrying the validation error back.
- `PlacementCritique` with `ok=False` and no `ConstraintDelta[]` is **coerced to `ok=True`** — CP-SAT is deterministic, so a rejection with no structural delta cannot change the solver's answer and would only spin the loop to its cap. Likewise `IntakeSpec` synthesises a question for an unknown the model listed but forgot to ask about.

### State

`PlanState` (`app/graph/state.py`) stores **raw data, not formatted text** — prompts are formatted in the node that needs them, which is also what keeps checkpoints small and diffable.

**Returning `[]` does not clear an `Annotated[list, operator.add]` key** — the empty value is merged and the old entries survive. To replace a plan wholesale (the replan case), return `{"items": Overwrite([])}`.

### Traps worth knowing before you edit

- **The API package is `sutra_api`, not `app`.** `apps/agent` already owns the top-level `app` package and both are imported into one process; two packages named `app` cannot coexist. HLD §5 says `apps/api/app/` — that is now wrong.
- **`app/studio.py` compiles with `checkpointer=None` on purpose.** The LangGraph Agent Server injects its own persistence and rejects a graph that brings one ("includes a custom checkpointer" is a hard startup error). Durable checkpointing for the product lives in `apps/api` against Postgres.
- **Auth has exactly one resolver** (`deps.resolve_user`). v1's bearer bug — four routes with *their own inline resolvers* that accepted an ungated `Authorization: Bearer <any-id>` and used it as the `user_id` — is the reason. Do not add a second path. There is also no CSRF token; `security.origin_is_same_site` enforces an origin check on every mutating request and **fails closed**.
- **Backward compatibility is a release constraint.** LangGraph runs the newest deployed graph against previously persisted checkpoints, so never rename or remove a node a thread may be paused at, never rename or remove a state key, and never tighten a field. Add keys as `NotRequired`. Edge topology is *not* persisted, so edges may be rerouted freely.
- **`core/` must stay pure.** It imports no DB, network, or LLM client, and a test enforces it.

### The seam that makes it testable

`complete` (the LLM call) is **injected**, never imported by a node — `build_plan_graph(*, complete, checkpointer)` captures it in the node closures. Tests pass a fake and run the whole graph with no model. `deps={"complete": fake_complete}` for pure-function tests, `context_schema` for graph-level ones. Do not reach for a module-level LLM client inside a node.

### What is not built

`/chat/*` (needs a plan for a separate `sutra_chat` package), the motivation pipeline's `_generate()`, PDF/DOCX/image text extraction, and the `/plan/runs` baseline table. See `apps/api/README.md` for the current status table.
