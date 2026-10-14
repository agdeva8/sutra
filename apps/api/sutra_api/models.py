"""The schema of record — 21 tables, ported from v1's Drizzle definitions.

Ported from `api/db/schema.ts` + `api/db/migrations/*.sql`. Three v1 decisions
are reproduced deliberately, because breaking them changes behaviour:

1. **No Postgres enums and no CHECK constraints.** v1 had zero of either —
   Drizzle's `text('col', { enum: [...] })` is TypeScript-only and emits plain
   `text`. Every vocabulary below is validated at the route boundary, not in the
   database. Adding a real enum here would make a future value a migration
   instead of a one-line change, which is not the trade v1 made.
2. **`updated_at` is the application's job.** There are no triggers. `onupdate`
   covers ORM writes; raw `UPDATE`s must set it.
3. **Ids are opaque `text`**, `<prefix>_<hex>` — see `ids.py`. Composite primary
   keys are used where the pair *is* the identity (`daily_log`, `plan_staleness`,
   `motivation_cache`, `motivation_served_log`), matching v1.

Two v1 tables are dropped rather than ported: `accounts`, `sessions` and
`verification_tokens` are Auth.js adapter artifacts with no analogue once auth
is cookie-based and local, and `state_overrides` was write-only dead weight kept
alive in v1 solely so a guest-migration `UPDATE` would not fail.

`commitments` is also gone — v1 dropped it in migration 0013 and folded it into
`plan_items` with `horizon='daily'`. This port simply never creates it. Note
that `memories` (photo/Instagram keepsakes) and `user_facts` (durable facts about
the user) are **different tables with different purposes**; the OpenAPI spec
conflates them. See CONTRACT-RECONCILIATION.md #53.
"""
from __future__ import annotations

from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    UniqueConstraint,
    desc,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, Timestamped

# ---------------------------------------------------------------------------
# Vocabularies. Validated at the boundary, never by the database (see module
# docstring). Kept here so a route and a test read the same list.
# ---------------------------------------------------------------------------

GOAL_HORIZONS = ("weekly", "short", "medium", "long")
GOAL_STATUSES = ("active", "paused", "dropped")
DRIFT_STATUSES = ("on_track", "at_risk")
PLAN_HORIZONS = ("daily", "weekly", "monthly", "quarterly", "yearly")
PLAN_ITEM_STATUSES = ("open", "done")
BLOCKER_KINDS = ("commitment", "routine", "blocker", "focus")
BLOCKER_SOURCES = ("manual", "plan", "commitment", "blocker")
SOURCE_KINDS = ("file", "link")
MEMORY_KINDS = ("photo", "instagram")
CONVERSATION_KINDS = (
    "general",
    "add_goal",
    "plan_day",
    "review_progress",
    "edit_goal",
    "drop_goal",
)
CONVERSATION_STATUSES = ("open", "closed")
MESSAGE_ROLES = ("user", "assistant")
PROPOSAL_STATUSES = ("pending", "confirmed", "rejected")
MOTIVATION_BUCKETS = ("overdue", "dormant", "stuck")

#: v1's `SCOPE_TO_KIND` — a semantic scope collapses onto a conversation kind.
SCOPE_TO_KIND = {
    "goal": "add_goal",
    "commitment": "plan_day",
    "milestone": "plan_day",
    "blocker": "plan_day",
    "generic": "general",
}


# ---------------------------------------------------------------------------
# users / auth
# ---------------------------------------------------------------------------


class User(Timestamped, Base):
    """A user — and a guest is just a user with `is_guest = true`.

    v1 kept guests in this table rather than in a shadow one, which is why
    `ON DELETE CASCADE` from here wipes every row the user owns. There is no
    `updated_at` in v1's `users`; the timestamp mixin adds one, which is
    harmless and avoids a special case.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str | None] = mapped_column(String, unique=True)
    name: Mapped[str | None] = mapped_column(String)
    image: Mapped[str | None] = mapped_column(String)
    email_verified: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    model_provider: Mapped[str] = mapped_column(String, nullable=False, default="gemini")
    is_guest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: Dev-persona display handle, not an identity — `id` stays the auth key.
    persona_key: Mapped[str | None] = mapped_column(String)
    persona_weight: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: NULL means "not set", which makes the headroom check advisory only.
    available_weekly_hours: Mapped[int | None] = mapped_column(Integer)
    #: `{mon: 2, tue: 0, …}`. A missing day is zero, not an error.
    availability: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        # Partial unique. A plain unique index would reject the second
        # persona-free row, and almost every row is persona-free.
        Index(
            "users_persona_key_unique",
            "persona_key",
            unique=True,
            postgresql_where=text("persona_key IS NOT NULL"),
        ),
    )


class UserSession(Base):
    """Opaque session tokens. The cookie is a DB handle, not a signed claim.

    v1 verified a session cookie by looking the token up here rather than by
    checking a signature — so revocation is a `DELETE`, not a key rotation.
    """

    __tablename__ = "user_sessions"

    session_token: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("user_sessions_user_id_idx", "user_id"),)


# ---------------------------------------------------------------------------
# goals / milestones / plan_items
# ---------------------------------------------------------------------------


class Goal(Timestamped, Base):
    """The goal. `plan_generation` lives in `PlanStaleness`, not here."""

    __tablename__ = "goals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    horizon: Mapped[str] = mapped_column(String, nullable=False)  # GOAL_HORIZONS
    #: The user's own words. Shown back verbatim, never paraphrased.
    why: Mapped[str] = mapped_column(String, nullable=False, default="")
    next_action: Mapped[str] = mapped_column(String, nullable=False, default="")
    start_date: Mapped[date | None] = mapped_column(Date)
    target_date: Mapped[date | None] = mapped_column(Date)
    #: NULL = not yet estimated. Excluded from the capacity load sum, which is
    #: why it is nullable rather than defaulting to 0.
    weekly_hours: Mapped[int | None] = mapped_column(Integer)
    #: `{"<phase>": "<objective>"}`, 2-4 entries.
    phase_objectives: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    drift_status: Mapped[str] = mapped_column(String, nullable=False, default="on_track")
    #: Free text despite the UI's fixed list — v1 never validated it.
    life_area: Mapped[str] = mapped_column(String, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="active")
    #: Total effort the goal needs, in hours, so progress can be measured against it. NULL = not stated.
    total_hours: Mapped[float | None] = mapped_column(Float)

    milestones: Mapped[list["Milestone"]] = relationship(
        back_populates="goal", cascade="all, delete-orphan", passive_deletes=True
    )


class Milestone(Timestamped, Base):
    """An OUTCOME checkpoint — an overlay chip, not a plan level (HLD §8.1).

    `goal_id` is `SET NULL`, not `CASCADE`: the chip survives its goal, keeping
    the denormalised `goal_title` as the only remaining trace. v1 made the same
    choice here and the opposite one for `plan_items`.
    """

    __tablename__ = "milestones"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="SET NULL")
    )
    goal_title: Mapped[str] = mapped_column(String, nullable=False, default="")
    title: Mapped[str] = mapped_column(String, nullable=False)
    target_date: Mapped[date | None] = mapped_column(Date)
    phase: Mapped[str] = mapped_column(String, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")

    goal: Mapped[Goal | None] = relationship(back_populates="milestones")

    __table_args__ = (Index("milestones_goal_id_idx", "goal_id"),)


class PlanItem(Base):
    """One row of the schedule of record, across all five horizons.

    **The solver is the only writer of the dates.** A row is never updated in
    place by a replan — every write is `DELETE WHERE goal_id = ?` + `INSERT`,
    in one transaction (HLD §9.4). A user-owned daily task is the exception: it
    is created directly by `POST /plan-items` and only its `status` is editable.
    """

    __tablename__ = "plan_items"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="CASCADE")
    )
    horizon: Mapped[str] = mapped_column(String, nullable=False)  # PLAN_HORIZONS
    phase: Mapped[str] = mapped_column(String, nullable=False, default="")
    title: Mapped[str] = mapped_column(String, nullable=False)
    note: Mapped[str] = mapped_column(String, nullable=False, default="")
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date)
    weekly_hours: Mapped[int | None] = mapped_column(Integer)
    #: Stored as `open|done` (v1's vocabulary). The agent emits `pending`; the
    #: API normalises it on write — see CONTRACT-RECONCILIATION.md #12.
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("plan_items_user_horizon_idx", "user_id", "horizon", "start_date"),
        Index("plan_items_goal_idx", "goal_id"),
    )


# ---------------------------------------------------------------------------
# capacity: blockers and fixed commitments
# ---------------------------------------------------------------------------


class Blocker(Base):
    """A date range the user cannot work — a hard constraint, not a preference.

    The solver treats every date in the range as zero capacity. `end_date` is
    nullable (an open-ended blocker), which is why the spec's "required" is
    wrong; on create it defaults to `start_date`.
    """

    __tablename__ = "blockers"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("blockers_user_start_idx", "user_id", "start_date"),)


class TimetableBlock(Timestamped, Base):
    """An immovable commitment occupying specific hours.

    Distinct from a blocker in kind, not just in degree: a blocker removes
    capacity for a whole date range, a block occupies named hours on one date.
    """

    __tablename__ = "timetable_blocks"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    block_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time] = mapped_column(Time, nullable=False)
    end_time: Mapped[time] = mapped_column(Time, nullable=False)
    label: Mapped[str] = mapped_column(String, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False, default="commitment")
    source: Mapped[str] = mapped_column(String, nullable=False, default="manual")
    #: Points at a `plan_items` or `blockers` row by convention — no FK in v1.
    source_id: Mapped[str | None] = mapped_column(String)
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="SET NULL")
    )
    goal_title: Mapped[str] = mapped_column(String, nullable=False, default="")
    note: Mapped[str] = mapped_column(String, nullable=False, default="")

    __table_args__ = (
        Index("timetable_blocks_user_date_idx", "user_id", "block_date", "start_time"),
    )


class RecurringBlock(Base):
    """A fixed commitment that repeats ("class every Tuesday and Thursday 6 to 8pm") until it is stopped.

    The rule is the source of truth; its occurrences are laid out as ordinary `timetable_blocks`
    (`source = "recurring"`, `source_id` = the rule), a rolling window ahead that the nightly tick keeps
    extending. Stopping sets `end_date` and removes the occurrences after it.
    """

    __tablename__ = "recurring_blocks"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    #: Weekdays it falls on, Monday = 0.
    weekdays: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    start_time: Mapped[time] = mapped_column(Time, nullable=False)
    end_time: Mapped[time] = mapped_column(Time, nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    #: NULL = repeats until stopped.
    end_date: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("recurring_blocks_user_idx", "user_id", "end_date"),)


class Reminder(Base):
    """Something to remember at set times: a prescription, "call mom Sundays".

    Stores the *expanded* schedule as day and time lists rather than one row per
    dose, so a 5-day course is one row and one undo. Code produces both lists
    (agentv2.core.recur); the model only supplies frequency and duration.
    """

    __tablename__ = "reminders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    #: ISO dates and HH:MM strings.
    days: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    times: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    #: Where it came from ("scratch", entry id), for the origin line.
    source: Mapped[str] = mapped_column(String, nullable=False, default="manual")
    source_id: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("reminders_user_idx", "user_id", "created_at"),)


SCRATCH_KINDS = ("text", "image", "audio", "file")
SCRATCH_STATUSES = ("pending", "processing", "handled", "needs_input", "failed")


class ScratchEntry(Base):
    """One thing the user dumped into Scratch (docs/prd/scratchpad.md).

    `body` is the user's own words, or the voice transcript, and is never
    rewritten. `status` is the queue: a row is durable before any model runs, so
    a failed inference never loses the sentence.
    """

    __tablename__ = "scratch_entries"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)  # SCRATCH_KINDS
    body: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source_id: Mapped[str | None] = mapped_column(
        ForeignKey("sources.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    #: The user's IANA timezone when they wrote it, so a note filed later still means the right "today".
    tz: Mapped[str | None] = mapped_column(String)
    #: The one thing we need from the user, for `needs_input`.
    question: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    #: What the agent did: `{"bucket": ..., "lines": [...], "proposed": bool}`.
    result: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    handled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("scratch_entries_user_status_idx", "user_id", "status", "created_at"),
    )


class CalendarFeed(Base):
    """A user's subscribable iCalendar feed, plus whether we have asked about it.

    One row per user. `token` is the only credential on the public `.ics` URL —
    calendar apps fetch it with no cookie — so it is long, random, and NULL when
    the user has revoked it. `prompted_at` records that the first-open prompt was
    answered either way, so it is asked once per account rather than per browser.
    """

    __tablename__ = "calendar_feeds"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    token: Mapped[str | None] = mapped_column(String, unique=True)
    prompted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    #: Last time a calendar app fetched the feed — how the UI says "connected".
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------------------------------------------------------------------
# sources — files, links, and the text extracted from them
# ---------------------------------------------------------------------------


class Source(Base):
    """An attached file or link.

    Soft-deleted (`is_deleted`), never hard-deleted: `user_facts.source_id` and
    the audit ledger reference rows, so a delete that removed the row would
    orphan the audit trail. The stored bytes are retained too — v1 called it an
    audit trail, and the cost is storage, not correctness.
    """

    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="SET NULL")
    )
    goal_title: Mapped[str] = mapped_column(String, nullable=False, default="")
    kind: Mapped[str] = mapped_column(String, nullable=False)  # SOURCE_KINDS
    storage_path: Mapped[str] = mapped_column(String, nullable=False, default="")
    original_filename: Mapped[str] = mapped_column(String, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    url: Mapped[str] = mapped_column(String, nullable=False, default="")
    #: Up to 8000 chars of extracted text. NULL for an image until OCR lands;
    #: the wire's `text_pending` is derived from the upload's content type, not
    #: from this column.
    text_excerpt: Mapped[str | None] = mapped_column(Text)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: Set only for a temporary, unlinked upload — 7 days, then the cron reaps it.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("sources_expires_at_idx", "expires_at"),
        # v1 filtered on (user_id, is_deleted) in every query and never indexed
        # it. Adding it here is a cheap fix, not a behaviour change.
        Index("sources_user_deleted_idx", "user_id", "is_deleted"),
    )


class Memory(Base):
    """A photo or Instagram keepsake — **not** a durable fact about the user.

    This is the table `/memories` serves, and it is the one place the OpenAPI
    spec is outright wrong: the spec's `Memory{id, text, source_id, created_at}`
    describes `user_facts` (a different resource, at a different route, with a
    different purpose). `Memories.js` renders an image grid; that shape has no
    image field. See CONTRACT-RECONCILIATION.md #53.
    """

    __tablename__ = "memories"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)  # MEMORY_KINDS
    caption: Mapped[str] = mapped_column(String, nullable=False, default="")
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="SET NULL")
    )
    goal_title: Mapped[str] = mapped_column(String, nullable=False, default="")
    #: Soft pointer to `sources.id` — no FK, matching v1.
    source_id: Mapped[str | None] = mapped_column(String)
    external_url: Mapped[str | None] = mapped_column(String)
    instagram_shortcode: Mapped[str | None] = mapped_column(String)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    mime_type: Mapped[str | None] = mapped_column(String)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    #: The calendar anchor — a memory is pinned to a day, not a timestamp.
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    extra: Mapped[dict] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("memories_user_date_idx", "user_id", "occurred_on"),)


class UserFact(Timestamped, Base):
    """A durable fact the coach has learned — "works in fintech", "is a dancer".

    Lives in a table rather than graph state because state is per-thread, and
    these must outlive every conversation. v1 served these at `/api/facts` from
    its Python service; the OpenAPI spec mistakenly documents this shape as
    `/memories`. The unique constraint on `(user_id, fact)` is the dedupe key
    for the upsert that raises a re-stated fact's confidence.
    """

    __tablename__ = "user_facts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    fact: Mapped[str] = mapped_column(String, nullable=False)
    #: The turn that surfaced it — a soft pointer, no FK.
    source_turn_id: Mapped[str | None] = mapped_column(String)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.7)

    __table_args__ = (
        Index("user_facts_user_idx", "user_id", "confidence", "updated_at"),
        UniqueConstraint("user_id", "fact", name="user_facts_user_fact_key"),
    )


# ---------------------------------------------------------------------------
# conversations / chat
# ---------------------------------------------------------------------------


class Conversation(Base):
    """A chat bucket. The id **is** the bucket key, so it is deterministic.

    `conv_general_<user_id>` is the default bucket; `conv_<kind>_<refId>` is a
    scoped one. Deterministic because a reload must land in the same
    conversation and a second plan for a goal must not fork a thread.

    A scoped bucket can be `closed` — the confirm flow seals it — after which
    the stream route redirects the client to a fresh bucket. The general bucket
    is never sealed.
    """

    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False, default="general")
    goal_id: Mapped[str | None] = mapped_column(
        ForeignKey("goals.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="open")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        # Partial: "this user's open conversations" is the hot lookup, and
        # closed buckets become the majority of the table over time.
        Index(
            "conversations_user_open_idx",
            "user_id",
            postgresql_where=text("status = 'open'"),
        ),
        Index(
            "conversations_user_recent_idx",
            "user_id",
            desc("last_message_at"),
        ),
    )


class Message(Base):
    """One turn. `provider` is the model that produced it, when known."""

    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String, nullable=False)  # MESSAGE_ROLES
    content: Mapped[str] = mapped_column(Text, nullable=False)
    provider: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("messages_conversation_created_idx", "conversation_id", "created_at"),
    )


class Proposal(Base):
    """A pending confirmable action.

    `args` is free-form JSON keyed by `action` — v1 had nine tool actions and
    this table never knew their shapes. `status` plus the `UPDATE … WHERE
    status = 'pending'` guard is what makes a retried confirm idempotent: the
    second attempt matches zero rows and 409s instead of double-applying.
    """

    __tablename__ = "proposals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    #: NULL for a proposal the agent raised outside chat (a Scratch entry), which
    #: has no message or conversation to hang off.
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=True
    )
    action: Mapped[str] = mapped_column(String, nullable=False)
    args: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    result: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("proposals_conversation_created_idx", "conversation_id", "created_at"),
        Index("proposals_message_id_idx", "message_id"),
    )


# ---------------------------------------------------------------------------
# audit
# ---------------------------------------------------------------------------


class AuditEntry(Base):
    """The append-only ledger. Written in the same transaction as its mutation.

    That co-transactionality is the point: an audit row that can be missing is
    not an audit trail. `type` is namespaced `<verb>:<object>` by convention
    (`confirm:add_plan_item`, `drift:goal`) and is never validated.
    """

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(String, nullable=False, default="")
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # v1 had no index here and ordered by created_at on every request.
        Index("audit_log_user_created_idx", "user_id", "created_at"),
    )


# ---------------------------------------------------------------------------
# staleness — the ledger behind the refresh button
# ---------------------------------------------------------------------------


class PlanStaleness(Base):
    """The baseline store: one row per (user, goal). The refresh button's zero.

    `generation` is bumped **only by a confirmed plan write** — never by an
    automatic re-solve, which would silently reset the user's "N changes"
    indicator.
    """

    __tablename__ = "plan_staleness"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    goal_id: Mapped[str] = mapped_column(
        ForeignKey("goals.id", ondelete="CASCADE"), primary_key=True
    )
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    last_planned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class PlanChange(Base):
    """Append-only: what changed, against which generation.

    Counting is by `generation`, never by timestamp. A change recorded in the
    same clock tick as the confirm — which is the normal case, since both happen
    in one request — would otherwise compare equal and flicker in and out of the
    count. Rows in a closed generation stay for the audit trail but stop
    counting.
    """

    __tablename__ = "plan_change_ledger"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    goal_id: Mapped[str] = mapped_column(
        ForeignKey("goals.id", ondelete="CASCADE"), nullable=False
    )
    generation: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    horizons_moved: Mapped[list[str]] = mapped_column(
        ARRAY(String), nullable=False, default=list
    )
    milestone_moved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    summary: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("plan_change_ledger_window_idx", "user_id", "goal_id", "generation"),
    )


# ---------------------------------------------------------------------------
# observability
# ---------------------------------------------------------------------------


class PlanThread(Base):
    """Which LangGraph thread holds a goal's current plan.

    The replan door needs this. A replan re-solves the **checkpointed** task set
    instead of re-deriving the plan's meaning (HLD §9.1), so it has to address
    the thread the plan was produced on. Nothing else records that: `plan_items`
    holds the dates but not the solver's inputs — a step's effort, its priority,
    its window — so a plan cannot be faithfully rebuilt from rows. Reconstructing
    it would quietly change the plan on every replan, which is the bug the door
    exists to prevent.

    It is also the only place in the schema with a **timestamp beside a thread
    id**. LangGraph's own tables (`checkpoints`, `checkpoint_blobs`,
    `checkpoint_writes`) carry no time column at all, so checkpoint retention —
    HLD §11.1, "an operational requirement, not an optimisation" — is not
    expressible without a ledger like this one.

    One row per (user, goal): a goal has one current plan, and a replan rewrites
    it in place (HLD §9.4, replace-on-write).
    """

    __tablename__ = "plan_threads"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    goal_id: Mapped[str] = mapped_column(
        ForeignKey("goals.id", ondelete="CASCADE"), primary_key=True
    )
    #: The thread the current plan lives on. Advanced on every confirmed plan
    #: write, exactly like `plan_staleness.last_planned_at`.
    thread_id: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (Index("plan_threads_thread_idx", "thread_id"),)


class PlanReject(Base):
    """One row per rejected stage, so the reject rate is measurable per stage.

    Without this the pipeline's failures are invisible: a stage that rejects
    everything and one that rejects nothing produce the same user-visible
    `no_change`.
    """

    __tablename__ = "plan_rejects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    intent: Mapped[str] = mapped_column(String, nullable=False)
    stage: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[str] = mapped_column(String, nullable=False, default="")
    raw_input: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    raw_output: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    recovered: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# ---------------------------------------------------------------------------
# motivation
# ---------------------------------------------------------------------------


class MotivationCache(Base):
    """A generated recommendation set, keyed by bucket **and** state hash.

    The `state_hash` in the key is what stops a stale set from being served
    after the user's state moves: a changed hash is a different row, not an
    overwrite.
    """

    __tablename__ = "motivation_cache"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    bucket: Mapped[str] = mapped_column(String, primary_key=True)
    state_hash: Mapped[str] = mapped_column(String, primary_key=True)
    items: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (Index("motivation_cache_expires_idx", "expires_at"),)


class MotivationReject(Base):
    """Write-only telemetry: why a candidate was not served.

    This is what makes the scoring gates tunable — without it, a filter that
    rejects everything looks identical to a search that returned nothing.
    """

    __tablename__ = "motivation_rejects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    bucket: Mapped[str] = mapped_column(String, nullable=False)
    url: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    score_breakdown: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    weighted_total: Mapped[float] = mapped_column(Float, nullable=False)
    top_reasons: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    gates_failed: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("motivation_rejects_user_bucket_idx", "user_id", "bucket", "created_at"),
    )


class MotivationServedLog(Base):
    """The daily-cap counter, one row per (user, day)."""

    __tablename__ = "motivation_served_log"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    served_on: Mapped[date] = mapped_column(Date, primary_key=True)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


# ---------------------------------------------------------------------------
# daily log — the execution layer
# ---------------------------------------------------------------------------


class DailyLog(Timestamped, Base):
    """What actually happened today, as opposed to what was planned.

    The execution layer, distinct from the outcome layer. Keyed `(user_id,
    log_date)` with no synthetic id, and written with an upsert that **merges**
    `commitments`/`blockers` by id rather than replacing the arrays — so a
    second write from a different surface does not erase the first's notes.
    """

    __tablename__ = "daily_log"

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    log_date: Mapped[date] = mapped_column(Date, primary_key=True)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    #: `[{plan_item_id, done, note}]`
    commitments: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    #: `[{blocker_id, skipped, note}]`
    blockers: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
