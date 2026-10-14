# GoalCoach API

The one HTTP surface `apps/web` talks to.

`apps/agentv2` is a **library**, not a service. It holds the planner and the coach (the Add-goal interview and chat). It has no HTTP surface of its own
and no second spec to drift out of sync: this app serves the planner routes by
importing it **in-process**, so the boundary between them is a function
call.

## Run it

```bash
# 1. Postgres (port 5433 — see infra/docker-compose.yml for why not 5432)
docker compose -f ../../infra/docker-compose.yml up -d

# 2. Dependencies. `sutra-agent` is a path dependency on ../agent.
cd apps/api
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -e ".[dev]"

# 3. Config
cp .env.example .env        # fill in AUTH_SECRET at minimum
set -a; source .env; set +a

# 4. Schema. There is no hand-written first migration — the models are the
#    schema of record, so autogenerate reads them.
.venv/bin/alembic revision --autogenerate -m "initial schema"
.venv/bin/alembic upgrade head

# 5. Serve
.venv/bin/uvicorn sutra_api.main:app --reload --port 8000
```

With no LLM key set, model-backed routes answer 503 ("the assistant isn't available"); everything else
runs with no network.

```bash
# Unit tests — pure modules only: no database, no network.
.venv/bin/python -m pytest tests/unit -q
```

## Layout

```
sutra_api/
  main.py          app factory, lifespan, the CSRF origin check
  config.py        every tunable
  deps.py          auth → CurrentUser, in ONE resolver
  models.py        21 tables, ported from v1's Drizzle schema
  wire.py          row → wire. The only place a shape is decided.
  dashboard.py     the /state snapshot — shared with /tools/confirm
  stream.py        the SSE frame union
  security.py      cookies, tokens, the origin check
  storage.py       Supabase Storage, with a local-disk fallback
  registry.py      the model catalog
  llm.py           a re-export of the agent's one LLM seam
  core/            PURE — no DB, no network
  store/           persistence
  api/             the routes, one module per spec tag
```

## Two things to read before changing anything

**1. `CONTRACT-RECONCILIATION.md`.** `openapi.yaml` claimed to be derived from
`apps/storybook/src/lib/api.js`. It was not: **39 shapes disagree** with the app
it says it was copied from. That document resolves all 70 disagreements
individually, against the v1 source, and records which way each went. Several
corrections are things a well-meaning reader would "fix" back to the broken
state — the docstrings say which.

**2. The package is `sutra_api`.** The planner and the coach live in `agentv2`, imported in-process.

## The security fix worth knowing about

v1's shared resolvers gated `Authorization: Bearer` behind `ALLOW_DEV_LOGIN`,
but `/auth/me`, `/sources*`, `/sources/{id}/download` and `/audit/export` had
their **own inline resolvers** that accepted an *ungated* bearer and used it as
the `user_id`. `Bearer <any-id>` read that user's data with no credential.

Here the gate lives in one function (`deps.resolve_user`) and there is no second
path. There is also no CSRF token — v1 had none, and the spec's own note records
that it cannot express one — so `security.origin_is_same_site` enforces an origin
check on every mutating request, failing **closed**.

## What is not built

| subsystem | status |
|---|---|
| `/chat/*` (stream, history, plan, refine) and `/sources/link/ask` | served by `agentv2` (planning and `agentv2.coach`, the interview and chat), called in-process. |
| the motivation pipeline | the route, the cache contract and the bucket logic all work; `_generate()` returns an empty set. Needs a search key and the critique loop. |
| PDF / DOCX / image text extraction | named in `core/extract.py`. An empty excerpt is already the "unreadable" signal the planner expects, so a PDF attaches and simply contributes nothing yet. |
| the `/plan/runs` baseline table | `/plan/confirm`'s 409 uses the conversation's `last_message_at` as the baseline. Correct for the normal flow, with a one-request-wide window. See `api/plan.py`. |
