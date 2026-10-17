# Deploying Sutra

Three things ship: the **API** (a Vercel function that includes agentv2), the **web app** (a static build), and the **database** (Supabase Postgres, migrated by Alembic). All three are driven by one GitHub Actions workflow, [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

- API: <https://sutra-api-neon.vercel.app>
- Web: <https://gurusutra.vercel.app>

## How a deploy runs

`develop_v2` is the production branch. A push to it runs:

```
push to develop_v2
  └─ test       agentv2 + api unit tests, web tests and build
  └─ database   alembic current → alembic upgrade head → backfill (if needed)
  └─ api        vercel pull → vercel build → vercel deploy --prebuilt --prod
  └─ web        vercel pull → vercel build → vercel deploy --prebuilt --prod
  └─ after      catch-up backfill (only if one ran) → smoke test → fetch the web app
```

The order is the point. **Migrations run before the code that needs them**, and the copy out of the old tables runs before that. The deploys live in this workflow rather than in Vercel's own Git integration *because* of that ordering: Vercel builds on push, so its own production deploy would race the migration and could serve code against a schema that does not exist yet. Vercel's Git deployment for `develop_v2` is therefore disabled in both `vercel.json` files (`git.deploymentEnabled`), and the only way production changes is this workflow.

`cancel-in-progress` is `false` and the concurrency group is per-branch: a cancelled run can stop between `alembic upgrade` and the deploy that expects it.

**A pull request into `develop_v2` runs the same steps as a dry run.** Tests run, the database job prints the SQL that `alembic upgrade head` would run and runs the backfill without writing, and both Vercel projects are built — but nothing is deployed and nothing is written to the database. This catches a broken migration or a broken Vercel build before it is on the production branch.

**`workflow_dispatch`** takes a `mode`: `check` (default), `deploy`, or `backfill`.

## One-time setup

### GitHub secrets

Repository → Settings → Secrets and variables → Actions → **Secrets**.

| Secret | Where it comes from |
|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens. Needs access to the `team_ZV1knwQVyeSguCG8G9xLLZ2a` team. |
| `DATABASE_URL_UNPOOLED` | Supabase → Connect → **Session pooler**, port **5432** — not the transaction pooler on 6543. Alembic runs DDL, which must not share a multiplexed session. Give it the `postgresql://…` form; `sutra_api/config.py` rewrites it to `postgresql+asyncpg://`. |

The workflow exports this one secret as *both* `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, so the app and Alembic agree on which database they are pointed at.

### GitHub variables

Same screen, **Variables** tab.

| Variable | Value |
|---|---|
| `VERCEL_ORG_ID` | `team_ZV1knwQVyeSguCG8G9xLLZ2a` |
| `VERCEL_API_PROJECT_ID` | `prj_z178SIbfmOUkOpWwt1IRx0kWdMXx` |
| `VERCEL_WEB_PROJECT_ID` | The `gurusutra` project's id (Vercel → project → Settings → General). |

The org id and project ids are what make `vercel pull` non-interactive; without them the CLI stops and asks.

### Vercel

In **both** projects (Settings → Git → Production Branch), set the production branch to **`develop_v2`**. Vercel's own deployment for that branch stays disabled by `deploymentEnabled`, but naming it the production branch is what makes `vercel deploy --prebuilt --prod` and a later promotion both mean "this is production".

## The first deploy of the block tables

The four-kind calendar blocks release moved every block row into a new `calendar_blocks` table. That release deploys with a one-time copy:

1. `database` migrates (creating `calendar_blocks`), then asks `scripts/deploy_checks.py blocks-empty`.
2. While the table is empty it exits 0, and `backfill_blocks.py --apply` copies every old row in — one transaction, keeping ids, skipping ids that already exist.
3. The job reports `backfilled=true`, and the `after` job runs the same copy again once the new code is live. The old code was serving traffic during the migration and the deploy, so rows it wrote in that window are missing from the new table; the second pass picks them up.

Neither pass can double-write: the guard is emptiness, and the script skips ids it already sees.

**Recovery, if a run fails after its backfill.** The catch-up pass is the only thing skipped by a failure in `after`, and it is the one that matters. Re-run the workflow from the Actions tab with **`mode: backfill`** and it applies the copy again without touching the tests or either deploy. Do this after the next successful deploy, so the code that reads `calendar_blocks` is live first.

## Rolling back

Promote the previous deployment in Vercel (Project → Deployments → the last good one → Promote to Production), for the API and the web app independently if only one is bad.

This is safe because **migrations are additive**: every migration in `apps/api/migrations/versions` adds a table, a column, or a nullable constraint — nothing is dropped, renamed, or tightened. Old code keeps working on the new schema, so a rollback is a code rollback and does not need a database rollback. If you ever add a migration that is not additive, this stops being true and the rollback needs a plan of its own.

A rollback does not re-run this workflow, so it cannot re-migrate anything either.

## Database check before deploying

The `database` job prints where it is pointed before it changes anything:

```bash
cd apps/api && .venv/bin/python scripts/deploy_checks.py where
```

It prints the host (never the user or password) and, for a Supabase pooler host, the database's region and the Vercel region code that should match it. A Vercel function runs in one region and the database lives in another, and every query pays the round trip between them; when `vercel.json` names the wrong one the script emits a `::warning::` annotation on the run.

Nothing pins `regions` yet. Run the workflow once, read the region it reports, and add `"regions": ["<code>"]` to the repo-root `vercel.json` if it is not Vercel's default (`iad1`).

To see the local database instead, run it from `apps/api` with the local `.env` — it prints `localhost` and no region.

## Environment variables (the API)

Set in the Vercel project for production, not read from a file.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgresql+asyncpg://user:pass@host:5432/db`. The transaction pooler (6543) is the right target for the running app. |
| `DATABASE_URL_UNPOOLED` | no | Alembic's DDL connection. Falls back to `DATABASE_URL`. |
| `AUTH_SECRET` | yes | 32+ random characters: `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `DEEPSEEK_API_KEY` | yes | without it the agent routes return 503 "assistant isn't available" |
| `LLM_PROVIDER` | no | `deepseek` (default) or `anthropic`. With `anthropic`, `CLAUDE_API_KEY` is required and `CLAUDE_MODEL` (default `claude-sonnet-5-5`) picks the model |
| `DEEPSEEK_MODEL` | no | defaults to `deepseek-v4-flash`, the model that reads images |
| `APP_ENV` | yes | `production` |
| `CORS_ALLOWED_ORIGINS` | yes | a **JSON list**, e.g. `["https://gurusutra.vercel.app"]`. A bare URL crashes settings parsing. |
| `CALENDAR_FEED_BASE_URL` | yes in practice | the API's public origin, so calendar apps can fetch the `.ics` feed |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET` | yes in practice | uploads (photos, files). Without them files fall back to per-instance disk and are lost |
| `CRON_SECRET` | yes for the nightly tick | shared secret the scheduler sends to `/cron/*` |
| `BACKGROUND_INLINE` | yes on Vercel | `true`. A serverless host freezes the process once the response is sent, so work queued "after the response" may never finish. |
| `SUTRA_LLM_REQUESTS_PER_MINUTE` | no | per-user cap on model-backed routes, default 60 |
| `LANGSMITH_*` | no | tracing |

Probes: `/health` (liveness, no dependencies) and `/ready` (database reachable). The post-deploy smoke test hits both, then checks that the guarded routes answer 401 rather than 404 or 500:

```bash
apps/api/scripts/smoke.sh https://sutra-api-neon.vercel.app
```

## Nightly tick

Run once a night for all users, or point Supabase Cron at `GET /cron/tick` with `Authorization: Bearer $CRON_SECRET`:

```bash
cd apps/api && .venv/bin/python scripts/agent_tick.py
```

It lays out recurring commitments further ahead, gives day-level detail to weeks that have come into the window, and replans a goal when hours done and hours planned have drifted apart. Each user runs in its own transaction.

## Running the API in a container

Only needed for a self-hosted target; Vercel is the deployed one.

```bash
docker build -f apps/api/Dockerfile -t sutra-api .     # from the repo root
docker run --rm -p 8000:8000 --env-file prod.env sutra-api
```

It applies migrations on start unless `RUN_MIGRATIONS=0`. With more than one replica, run migrations as a separate step and set `RUN_MIGRATIONS=0` on the replicas.

## Known limits at launch

- Reminders are shown in Today and on the Timeline but nothing notifies the user (no push, no email).
- A model provider that queues requests (DeepSeek under load) makes Scratch and planning hang for minutes: the per-call timeout is a read timeout that keep-alive bytes can reset. A hard per-call deadline is not built yet.
- Every user is treated as being in IST (`USE_CLIENT_TIMEZONE = False` in `apps/agentv2/config.py`).
- The per-user model rate limit is per process.
- Scratch voice input depends on the browser's speech recognition (Chrome and Safari).
