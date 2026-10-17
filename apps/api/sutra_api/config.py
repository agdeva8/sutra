"""Settings — every tunable, read once.

Prefix-free env names, matching v1 where a name already existed
(`DATABASE_URL`, `AUTH_SECRET`, `ALLOW_DEV_LOGIN`, `DEEPSEEK_*`). The LLM keys
are deliberately *not* re-declared here: `apps/agentv2/config.py` reads
`SUTRA_LLM_*` / `DEEPSEEK_*` from `os.environ` itself, and duplicating them
would create a second source of truth for the model configuration.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── runtime ────────────────────────────────────────────────────────────
    env: Literal["development", "test", "production"] = Field(
        default="development", alias="APP_ENV"
    )
    debug: bool = False

    #: Where the routes are mounted. `apps/web` calls `/api/*`, and the OpenAPI
    #: spec lists its paths relative to that mount. Set to "" when a proxy
    #: already strips the prefix, so no route has to know.
    api_prefix: str = Field(default="/api", alias="API_PREFIX")

    # ── database ───────────────────────────────────────────────────────────
    # Async driver is required: the engine is `postgresql+asyncpg://`. v1's
    # `postgres://` URL is accepted and rewritten in `_normalise_db_url`.
    database_url: str = Field(
        default="postgresql+asyncpg://sutra:sutra@localhost:5433/sutra",
        alias="DATABASE_URL",
    )
    #: Alembic runs on a direct connection; a pooler multiplexes sessions and
    #: DDL runs must not share one. Falls back to `database_url`.
    database_url_unpooled: str = Field(default="", alias="DATABASE_URL_UNPOOLED")

    #: Serverless hosts freeze the process once a response is sent, so work queued "after the response"
    #: may never finish. When true, filing and replans run inside the request instead (see `background.py`).
    background_inline: bool = Field(default=False, alias="BACKGROUND_INLINE")
    #: Shared secret the platform scheduler sends (`Authorization: Bearer ...`) to the `/cron/*` routes.
    cron_secret: str = Field(default="", alias="CRON_SECRET")

    # ── background jobs ────────────────────────────────────────────────────
    #: How long a worker may hold a claimed job. Longer than the host's 300 s function limit on
    #: purpose: the lease is a crash detector, not a timeout — a lease that expires while the
    #: function is still legitimately working would let a second worker start the same job.
    job_lease_seconds: int = 360
    #: Attempts before a job is marked failed. Lease expiry counts as an attempt.
    job_max_attempts: int = 3
    #: How long a retry waits before it becomes claimable again.
    job_retry_delay_seconds: int = 60
    #: Wall-clock budget for one cron drain. Leaves headroom inside the 300 s function limit for
    #: the HTTP round trip and the response, and is checked between jobs so a drain never overruns.
    cron_jobs_budget_seconds: int = 240
    #: Finished jobs stay in `/state` this long, so a toast and an Undo survive a screen refresh.
    jobs_recent_minutes: int = 10
    #: How many jobs `/state` reports. Active jobs are always included; this bounds the finished tail.
    jobs_report_limit: int = 20

    # ── auth ───────────────────────────────────────────────────────────────
    #: HMAC key for the guest cookie. v1 required >= 32 chars; kept.
    auth_secret: str = Field(default="", alias="AUTH_SECRET")
    #: Dev personas + `GET /auth/dev-login`. Anything but the exact string
    #: "true" disables them, and the routes then 404 (not 403) — v1's rule,
    #: because a 404 is what a normal deployment looks like.
    allow_dev_login: bool = Field(default=False, alias="ALLOW_DEV_LOGIN")

    #: Where `/auth/session` exchanges a provider `session_id` for a user.
    #: v1 called Emergent's endpoint. Empty means the exchange is not
    #: configured, and the route says so instead of pretending to authenticate.
    auth_exchange_url: str = Field(default="", alias="AUTH_EXCHANGE_URL")
    auth_exchange_timeout_ms: int = 15_000

    session_cookie: str = "session_token"
    guest_cookie: str = "guest_token"
    #: 7 days, and — deliberately — 10 minutes. v1's guest TTL is short as an
    #: anti-abuse measure; it is a locked decision, not a round number.
    session_ttl_seconds: int = 7 * 24 * 60 * 60
    guest_ttl_seconds: int = 60 * 10

    #: An unset allowlist means every origin that CORS_ALLOWED_ORIGIN permits.
    cors_allowed_origins: list[str] = Field(default_factory=list)

    # ── storage ────────────────────────────────────────────────────────────
    #: Supabase Storage. With no URL configured, `storage.py` falls back to a
    #: local directory, so the service runs without credentials.
    supabase_url: str = Field(default="", alias="SUPABASE_URL")
    supabase_service_key: str = Field(default="", alias="SUPABASE_SERVICE_KEY")
    supabase_bucket: str = Field(default="goalcoach", alias="SUPABASE_BUCKET")
    local_storage_dir: str = Field(default=".data/sources", alias="LOCAL_STORAGE_DIR")

    #: Vercel sets `VERCEL=1` in every function. Disk is per-instance and ephemeral there.
    vercel: str = Field(default="", alias="VERCEL")

    #: When true, `/ready` fails without a real provider key. Off by default,
    #: because the agent's offline stub is a supported mode and failing
    #: readiness there would make the service undeployable with no keys.
    require_llm_provider: bool = Field(default=False, alias="REQUIRE_LLM_PROVIDER")

    # ── the planner ────────────────────────────────────────────────────────
    goal_planner_enabled: bool = Field(default=True, alias="GOAL_PLANNER_ENABLED")
    #: Empty means "everyone". Non-empty dark-launches the planner to the ids
    #: listed — HLD §14's degradation switch.
    goal_planner_allowlist: list[str] = Field(
        default_factory=list, alias="GOAL_PLANNER_USER_ALLOWLIST"
    )

    # ── chat ───────────────────────────────────────────────────────────────
    chat_history_limit: int = 200
    source_max_bytes: int = 20 * 1024 * 1024
    #: Files one request may attach. The Scratch composer is the batch surface, and the client mirrors
    #: this in `constants/limits.js` so the person is told before spending an upload on it.
    source_max_files_per_upload: int = 10
    text_excerpt_max: int = 8000
    link_fetch_timeout_ms: int = 12_000
    link_fetch_max_bytes: int = 256 * 1024
    link_max_redirects: int = 5

    # ── calendar feed ──────────────────────────────────────────────────────
    #: Absolute origin calendar apps use to fetch the `.ics` feed, e.g.
    #: `https://api.sutra.app`. Empty = derive from the request, which is right
    #: locally but wrong behind a proxy that rewrites the host. Google fetches
    #: from its own servers, so a localhost URL only works for Apple/Outlook desktop.
    calendar_feed_base_url: str = Field(default="", alias="CALENDAR_FEED_BASE_URL")
    #: How far back the feed reaches. Past steps stay visible for context, but a
    #: years-long history would bloat every refresh.
    calendar_feed_past_days: int = 60

    # ── motivation ─────────────────────────────────────────────────────────
    #: Master switch for the nudge card. When off, `/motivation/recommend`
    #: answers with a warm empty set rather than a permanent miss — see
    #: `api/motivation.py` for why that distinction is load-bearing.
    motivation_enabled: bool = Field(default=True, alias="MOTIVATION_AGENT_ENABLED")
    #: The generation pipeline (search + critique + frame) is not built yet. Until
    #: it is, the route serves the cache contract with an empty set.
    motivation_pipeline_enabled: bool = Field(
        default=False, alias="MOTIVATION_PIPELINE_ENABLED"
    )
    motivation_cache_ttl_seconds: int = 60 * 60
    motivation_stale_ttl_seconds: int = 24 * 60 * 60

    @field_validator("cors_allowed_origins", "goal_planner_allowlist", mode="before")
    @classmethod
    def _split_csv(cls, v: object) -> object:
        """Accept `a,b,c` from the environment as well as a JSON list."""
        if isinstance(v, str):
            return [p.strip() for p in v.split(",") if p.strip()]
        return v

    @field_validator("database_url", "database_url_unpooled", mode="after")
    @classmethod
    def _normalise_db_url(cls, v: str) -> str:
        """Rewrite a bare/psycopg URL to the asyncpg driver.

        v1's `.env` says `postgres://…`; asyncpg needs `postgresql+asyncpg://`.
        Without this the failure is a confusing "dialect not found" at boot.
        """
        if not v:
            return v
        if v.startswith("postgres://"):
            return "postgresql+asyncpg://" + v[len("postgres://"):]
        if v.startswith("postgresql://"):
            return "postgresql+asyncpg://" + v[len("postgresql://"):]
        return v

    @property
    def is_prod(self) -> bool:
        return self.env == "production"

    @property
    def is_serverless(self) -> bool:
        return bool(self.vercel)

    @property
    def ddl_url(self) -> str:
        """The URL Alembic and `.setup()` use — direct, never pooled."""
        return self.database_url_unpooled or self.database_url

    def planner_allowed_for(self, user_id: str) -> bool:
        if not self.goal_planner_enabled:
            return False
        if not self.goal_planner_allowlist:
            return True
        return user_id in self.goal_planner_allowlist


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
