# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Sutra / GoalCoach v2 — a planning agent that turns "switch jobs in 3 months" into a dated, multi-horizon plan and keeps it true as circumstances change. This is the `develop_v2` worktree: a fresh, Python-only backend with a React web app.

| Path | What it is |
|---|---|
| `apps/agentv2/` | **The agent — a library, not a service.** Python. Triage, goal intake, the hierarchical planner, the gateway (the one write path), and the coach (the Add-goal interview and chat). No HTTP surface. `docs/architecture/HLD-agentv2.md` is the design of record. |
| `apps/api/` | **The only HTTP surface.** FastAPI (`sutra_api`); imports `agentv2` in-process. Owns the database, auth, uploads, streaming, cron and calendar feeds. |
| `apps/web/` | The product UI (Create React App). Mobile-first. |
| `apps/storybook/` | Standalone Storybook (React 19 + Vite) used as a UI harness; mirrors some `apps/web` components. |
| `apps/api/openapi.yaml` | The product's HTTP contract. |
| `apps/api/CONTRACT-RECONCILIATION.md` | **Authoritative over `openapi.yaml`.** Where the spec disagrees with the app it claims to be derived from, this file says which way each shape went. Several corrections look wrong to a well-meaning reader and get "fixed" back to the broken state. |
| `docs/` | PRDs (`docs/prd/`), the agent design (`docs/architecture/HLD-agentv2.md`), and the deploy runbook (`docs/DEPLOY.md`). |
| `api/index.py`, `vercel.json` | The Vercel entry for the API (see Deployment). |

There is no v1 agent any more: `apps/agent`, the LangGraph planner, and the old `sutra_chat` package are gone. Do not reintroduce a second agent or a second chat package; add to `agentv2`.

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

This codebase already works this way and the pattern is to be followed, not reinvented: every tunable lives in a settings object or constants module (`apps/api/sutra_api/config.py`, `apps/agentv2/config.py`, `apps/web/src/constants/`), prompt prose lives in its own module (`apps/agentv2/prompts/`, `apps/agentv2/coach/prompts.py`) rather than inline in a stage, and shapes live in `apps/agentv2/contracts/`. Model ids and endpoints come from the environment, never from a literal in a function body.

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

- **It is not licence to remove a limit that exists for a real reason.** A cap that protects a shared budget, bounds an unbounded solver search, or stops a retry loop from spinning forever (`MAX_INTERVIEW_ROUNDS`, `MAX_QUESTIONS_PER_ROUND`, `FIX_MAX_LOOPS`) is load-bearing — the answer there is a *generous but finite* value, not `None`. Principle 5's "each layer verified" still applies: bounds come from observed behaviour, not from optimism.
- **It is not a reason to leave a failure unhandled.** Loosening the limit does not excuse skipping the degradation path — the failure ladder still stands, so a timeout that does eventually fire still has somewhere sane to go.


## Commands

### `apps/agentv2` — the agent library

```bash
cd apps/agentv2 && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e . pytest
cd apps/agentv2 && .venv/bin/python -m pytest tests/unit -q
cd apps/agentv2 && .venv/bin/python -m agentv2.demo <step>    # runs a step against the real model and Docker Postgres
```

The model is DeepSeek, configured in `apps/agentv2/config.py` and `apps/agentv2/.env` (`DEEPSEEK_API_KEY`, `DEEPSEEK_API_URL`, `DEEPSEEK_MODEL`). With no key, model-backed calls raise `ModelUnavailable` and the API answers 503; there is no offline stub, so a missing key is loud, not silent.

### `apps/api` — the service

```bash
docker compose -f infra/docker-compose.yml up -d     # Postgres on 5433, NOT 5432
cd apps/api && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e ".[dev]"
cd apps/api && set -a; source .env; set +a && .venv/bin/alembic upgrade head
cd apps/api && set -a; source .env; source ../agentv2/.env; set +a && .venv/bin/uvicorn sutra_api.main:app --reload --port 8000
cd apps/api && .venv/bin/python -m pytest tests/unit -q
cd apps/api && .venv/bin/python scripts/eval_intake.py       # 30 varied goals through the coach, real model
```

`models.py` is the schema of record; migrations are in `apps/api/migrations/versions/`. A revision id must be **32 characters or fewer** (`alembic_version.version_num` is `varchar(32)`).

### `apps/web`

```bash
cd apps/web && npm install --legacy-peer-deps && npm start        # needs REACT_APP_BACKEND_URL for a cross-origin API
cd apps/web && CI=false npm run build                              # CI=true turns lint warnings into errors
```

### `apps/storybook`

```bash
cd apps/storybook && pnpm install && pnpm storybook    # port 6007, not Storybook's usual 6006
```

When you change how the UI looks, call the Storybook MCP `stories-preview` and include the preview URLs in your reply.

### Tests

Per design principle 2, new unit tests are written when the user asks to commit a feature. Both Python apps default `pytest` to `tests/unit`, which imports only pure modules: no database, no network, no credentials. Integration tests hit a **shared** Postgres, so they are opt-in. There is no fixture that fakes Postgres: the schema uses `JSONB` and `ARRAY`, which SQLite cannot express.

## Architecture

### The locked boundary

> **The LLM owns meaning. Code owns dates and validity. Everything is written through the gateway.**

The model decides what the work is: goal title, milestones, which sessions a week needs, prose, the questions worth asking. Code supplies the calendar (free windows, capacity, blocked days, the user's profile), checks every change set (`core/validate.py`: no overlaps, capacity, blocks exist, nothing in the past), and is the only thing that writes. A model-chosen date that the code did not validate is a bug. The planner is hierarchical (month, week, day, slot), each level seeing one window; code checks the budget between levels.

### One write path: the gateway

`agentv2/gateway/` turns a `ChangeSet` into rows. It re-validates, auto-applies new goals, tasks, reminders and blocks, **proposes** anything that moves existing dated work, and writes an audit row in the same transaction. The audit row powers undo ("why this change?", and the link back to the Scratch entry). Nothing else writes plan rows.

### Where things live

- `agentv2/contracts/` — every shape. `_Strict` for models we build; lenient (`extra="ignore"`) for models the LLM fills, so a model volunteering `confidence` or `reason` never rejects the whole response. The prompt carries the real JSON schema, and a failed parse gets one repair round trip.
- `agentv2/core/` — pure. No DB, network, or LLM client (a test enforces it): validation, free-window computation, calendar maths, recurrence, the user profile mapped to planner settings.
- `agentv2/planner/`, `triage/`, `intake/`, `entrychat/`, `chatplan/` — the model-backed stages. Each takes an injected `chat` (a LangChain-style model) so tests pass a fake.
- `agentv2/coach/` — the Add-goal interview and coach chat: prompt modes, guardrails, the question discipline (`questions.py`: never ask a repeat, only questions that change a milestone, a date or the hours), a crisis check (`safety.py`), and answer chips.
- `apps/api/sutra_api/agent_store.py` — `SqlStore`, the database implementation of agentv2's `Store`.

### Failure ladder

**No model or solver failure ever 500s.** An unreadable model reply leaves the Scratch entry in Waiting with Retry; a plan that still breaks a rule after `FIX_MAX_LOOPS` falls back to first-fit or a proposal; gateway re-validation that fails writes nothing and logs a reject row. Programmer errors still propagate loudly.

### Long jobs stream progress

Planning a goal and filing a Scratch entry can take a minute or more. `sutra_api/stream.py:progress_stream` keeps the request open and emits `status` frames (the agent reports what it is doing via a `progress` callback) and a final `result` frame; clients ask with `Accept: text/event-stream` (`apps/web/src/lib/api.js:reqStream`). On a serverless host, work started after the response is not guaranteed to run, which is why the work runs inside the request. Scratch writes the entry first (`defer`), then files it with `POST /scratch/{id}/process`; entries left pending are filed on the next visit.

### Traps worth knowing before you edit

- **The API package is `sutra_api`.** `agentv2` imports nothing from it; the dependency runs one way.
- **Auth has exactly one resolver** (`deps.resolve_user`). v1's bearer bug (inline resolvers accepting an ungated `Authorization: Bearer <any-id>`) is why. Do not add a second path. There is no CSRF token: `security.origin_is_same_site` checks the origin on every mutating request and fails closed. `X-Timezone` must stay in the CORS allowed headers.
- **`CORS_ALLOWED_ORIGINS` is a JSON list** (`["https://gurusutra.vercel.app"]`); a bare URL crashes settings parsing.
- **Time zone:** `USE_CLIENT_TIMEZONE=False`, so every user is on `DEFAULT_TIMEZONE` (IST) until that is flipped.
- **Uploads:** storage is Supabase Storage when configured, then local disk, then the `source_blobs` table (a serverless host has no writable disk). `sources.purpose` keeps Memories photos (`memory`) out of the Sources list (`source`).
- **Guests can use the app but not calendar sync.** Each linked calendar is a `calendar_subscriptions` row with its own secret `.ics` URL; unlinking with "delete events" serves an empty feed for 30 days so the calendar app drops Sutra's events, and unlinking without it stops the feed.
- **First-run guide:** a user with no goals is held on the Goal screen with a non-dismissible Add Goal dialog; then the timeline step; then Scratch. Other prompts (install sheet, greeting) wait for it (`lib/guideActive.js`).
- **Backward compatibility is a release constraint** for anything persisted: add columns and keys as optional, never rename or tighten.
- **Pinch zoom stays on.** The document never scrolls (`index.css`); each screen scrolls inside its own container, so the top bar and bottom nav stay put.

### Deployment

Vercel for both apps, Supabase for Postgres (use the **pooler**: port 6543 for the app, the session pooler on 5432 for `alembic`). The API is `api/index.py` at the repo root (an ASGI shim that restores the original path from a rewrite) with `vercel.json`; the web app deploys from `apps/web`. `BACKGROUND_INLINE=true` runs background work inside the request. `docs/DEPLOY.md` is the runbook.

### What is not built

Notification delivery for reminders, goal proposals from repeated Scratch themes, importing a user's own calendars into the planner, `.docx` text extraction, durable file storage on Supabase Storage (set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to enable).
