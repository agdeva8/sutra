# Deploying Sutra

Three things ship: the **API** (a container that includes agentv2), the **web app** (a static build), and a **nightly job**. The database is Postgres.

Nothing here has been run against a deployed environment yet. The container builds and starts locally; the steps below are the runbook.

## 1. Database

The migrations in `apps/api/migrations/versions` are additive. The oldest one (`plan_threads`) assumes the base tables already exist, so on a **new** empty database run `Base.metadata.create_all` once, then `alembic stamp 20261010_1700_add_plan_threads` before upgrading (this is how the local database was built).

On an **existing** deployed database, look before changing anything:

```bash
cd apps/api
export DATABASE_URL=postgresql+asyncpg://...      # the deployed one
alembic current          # what is applied
alembic heads            # what this code expects: 20261015_1600_done_hours
alembic upgrade head --sql > /tmp/upgrade.sql     # read what it will run
```

If `alembic current` prints nothing on a database that already has tables, stamp it first (`alembic stamp 20261010_1700_add_plan_threads`), otherwise the first migration tries to create a table that exists. Take a backup before `alembic upgrade head`.

New in this release (all additive, nothing dropped or renamed): `reminders`, `scratch_entries`, `calendar_feeds`, `recurring_blocks`, `goal_progress` (the progress judge's cached verdict per goal), plus columns `scratch_entries.tz`, `goals.total_hours`, `plan_items.description`, `plan_items.why`, `plan_items.done_hours`, `timetable_blocks.why`, and `proposals.message_id` / `conversation_id` now nullable. Migrations from `20261015_1400_plan_why` on are new since the last deploy.

## 2. API container

```bash
docker build -f apps/api/Dockerfile -t sutra-api .     # from the repo root
docker run --rm -p 8000:8000 --env-file prod.env sutra-api
```

It applies migrations on start unless `RUN_MIGRATIONS=0`. With more than one replica, run migrations as a separate step and set `RUN_MIGRATIONS=0` on the replicas.

Environment (no `.env` file is baked into the image):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql+asyncpg://user:pass@host:5432/db` |
| `AUTH_SECRET` | yes | 32+ random characters: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `DEEPSEEK_API_KEY` | yes | without it the agent routes return 503 "assistant isn't available" |
| `LLM_PROVIDER` | no | `deepseek` (default) or `anthropic`. With `anthropic`, `CLAUDE_API_KEY` is required and `CLAUDE_MODEL` (default `claude-sonnet-5-5`) picks the model |
| `DEEPSEEK_MODEL` | no | defaults to `deepseek-v4-flash`, the model that reads images |
| `APP_ENV` | yes | `production` |
| `CORS_ALLOWED_ORIGINS` | yes | the web app's origin(s) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` | yes in practice | uploads (photos, files). Without them files go to the container's disk and are lost on restart |
| `SUTRA_LLM_REQUESTS_PER_MINUTE` | no | per-user cap on model-backed routes, default 60 |
| `LANGSMITH_*` | no | tracing |

Probes: `/health` (liveness, no dependencies) and `/ready` (database reachable).

The agent runs in the API process: there is no separate service to deploy.

## 3. Nightly tick

Run once a night for all users (cron, or the platform's scheduler):

```bash
cd apps/api && python scripts/agent_tick.py
```

It lays out recurring commitments further ahead, gives day-level detail to weeks that have come into the window, and plans a goal again when hours done and hours planned have drifted apart. Each user runs in its own transaction.

## 4. Web

`apps/web` is a Create React App build:

```bash
cd apps/web && REACT_APP_BACKEND_URL=https://<api-host> npm run build
```

Serve `build/` from any static host. The API sets cookies, so the web origin must be listed in `CORS_ALLOWED_ORIGINS` and both should be HTTPS.

## 5. Smoke test after a deploy

```bash
apps/api/scripts/smoke.sh https://<api-host>
```

## Known limits at launch

- Reminders are shown in Today and on the Timeline but nothing notifies the user (no push, no email).
- A model provider that queues requests (DeepSeek under load) makes Scratch and planning hang for minutes: the per-call timeout is a read timeout that keep-alive bytes can reset. A hard per-call deadline is not built yet.
- Every user is treated as being in IST (`USE_CLIENT_TIMEZONE = False` in `apps/agentv2/config.py`).
- The per-user model rate limit is per process.
- Scratch voice input depends on the browser's speech recognition (Chrome and Safari).
