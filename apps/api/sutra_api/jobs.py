"""The Postgres-backed job queue: enqueue, claim, run.

A plan can take a minute or more, and on a serverless host work started after the
response is not guaranteed to run. The row is therefore the queue: a change and the
job that re-plans around it are committed together (`enqueue` joins the caller's
transaction), and a worker takes the job with `FOR UPDATE SKIP LOCKED` and holds it
under a lease. Three things drain it — `POST /jobs/run` for the signed-in user, the
`/cron/jobs` drain, and the nightly tick enqueue — and they all go through `claim`,
which never lets two jobs for one user run at once.

The rule that decides what a job may do on its own:

* a re-plan that keeps every goal's **target date, weekly hours and open
  milestones** is applied, with one audit row saying what moved;
* a re-plan that would change any of them applies nothing and becomes a proposal.

The decision is pure (`keeps_goal_facts`) and is taken on the change set *before*
the gateway writes, which is why planning uses `agentv2.replan_preview` rather than
`replan_goal` (that one applies as it goes).

No failure here escapes as a 500: a job that cannot finish is retried up to
`JOB_MAX_ATTEMPTS`, then marked failed and the app offers Retry.
"""
from __future__ import annotations

import asyncio
import logging
from collections import Counter
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from time import monotonic

from agentv2 import ChangeSet, Origin, apply_changes, local_now, replan_conflicts, replan_preview, tick
from agentv2.contracts import Applied, Rejected
from sqlalchemy import exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import aliased

from .agent_store import AUDIT_APPLY, SqlStore
from .config import settings
from .db import get_engine
from .ids import new_id
from .models import (
    JOB_BUILD_PLAN,
    JOB_DONE,
    JOB_FAILED,
    JOB_KINDS,
    JOB_QUEUED,
    JOB_REPLAN_CONFLICTS,
    JOB_REPLAN_GOAL,
    JOB_RUNNING,
    JOB_TICK_USER,
    PLAN_FAILED,
    PLAN_PLANNING,
    PLAN_READY,
    AgentJob,
    AuditEntry,
    CalendarBlock,
    Goal,
    Milestone,
)
from .store import repo, staleness

log = logging.getLogger(__name__)

#: Jobs whose failure leaves a goal's schedule unbuilt, so the card must say so.
GOAL_PLAN_JOBS = (JOB_BUILD_PLAN, JOB_REPLAN_GOAL)

#: Why a fact-changing re-plan became a proposal. One sentence, shown on the proposal.
FACT_PROPOSAL_REASON = (
    "Re-planning would change this goal's deadline, weekly hours or milestones, so nothing was changed."
)

#: The first status line of a plan job, before the planner reports its own.
BUILD_FIRST = "Working out the schedule…"
CONFLICT_FIRST = "Checking the calendar…"
TICK_FIRST = "Ticking your plan…"

#: A job's stored error is for a person to read, not a log dump.
JOB_ERROR_MAX_CHARS = 500

#: `AgentJob.updated_at` is the app's job on raw writes (models.py, rule 2).
def _now() -> datetime:
    return datetime.now(UTC)


def _utc(value: datetime) -> datetime:
    """A naive timestamp from the database is UTC; make that explicit before comparing."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _maker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False)


# ---------------------------------------------------------------------------
# Pure decisions — unit-tested without a database
# ---------------------------------------------------------------------------


def dedupe_key_for(kind: str, goal_id: str | None) -> str:
    """One queued job per (user, kind, goal). A user-wide kind keys on `*`."""
    return f"{kind}:{goal_id or '*'}"


def job_is_claimable(
    *, status: str, run_after: datetime, now: datetime, running_for_user: bool
) -> bool:
    """Whether a queued row may start now. The `running_for_user` half is the one-per-user rule."""
    return status == JOB_QUEUED and _utc(run_after) <= _utc(now) and not running_for_user


def lease_outcome(attempts: int, max_attempts: int) -> str:
    """What a job becomes when its lease expires: retry while attempts remain, else failed."""
    return JOB_FAILED if attempts >= max_attempts else JOB_QUEUED


def lease_is_live(lease_until: datetime | None, now: datetime) -> bool:
    """A running job with no lease, or an expired one, has lost its worker."""
    return lease_until is not None and _utc(lease_until) > _utc(now)


@dataclass(frozen=True)
class GoalFacts:
    """The parts of a goal a background re-plan is not allowed to change on its own."""

    target_date: date | None
    weekly_hours: int | None
    #: Open milestones only: done ones record history and are never re-dated.
    milestones: frozenset[tuple[str, date | None]]


#: The change kinds that can restate a goal's facts. Everything the planner normally
#: emits (tasks, plan weeks, months, blocks) leaves them alone.
FACT_KINDS = ("add_goal", "add_milestone", "replace_milestones")


def facts_after(before: GoalFacts, changes, goal_id: str) -> GoalFacts | None:
    """The goal's facts as `changes` would leave them, or `None` when they cannot be followed.

    `None` means "something here is outside this job's scope" — a change naming another
    goal, for instance — and the caller must treat that as a change, not as no change.
    """
    facts = before
    for change in changes:
        kind = getattr(change, "kind", "")
        if kind == "add_goal":
            if change.id != goal_id:
                return None
            # A re-plan has no business creating goals; if it restates this one, keep the
            # deadline it states and otherwise leave the snapshot alone.
            facts = replace(facts, target_date=change.target_date or facts.target_date)
        elif kind == "add_milestone":
            if change.goal_id != goal_id:
                return None
            facts = replace(facts, milestones=facts.milestones | {(change.id, change.target_date)})
        elif kind == "replace_milestones":
            if change.goal_id != goal_id:
                return None
            facts = replace(
                facts,
                milestones=frozenset((m.id, m.target_date) for m in change.milestones),
            )
    return facts


def keeps_goal_facts(before: GoalFacts, changes, goal_id: str) -> bool:
    """Whether applying `changes` leaves the goal's deadline, hours and milestones as they were."""
    after = facts_after(before, changes, goal_id)
    return after is not None and after == before


def fact_changes(before: GoalFacts, changes, goal_id: str) -> list:
    """The changes that would alter the facts if applied one at a time.

    Used to decide what becomes a proposal when `keeps_goal_facts` says no: the
    offending changes are proposed, not the whole set, so an unrelated plan move is
    never silently dropped.
    """
    return [
        change
        for change in changes
        if getattr(change, "kind", "") in FACT_KINDS
        and not keeps_goal_facts(before, [change], goal_id)
    ]


@dataclass(frozen=True)
class PlannedSlot:
    """One session the planner placed, as the audit sentence needs to see it."""

    day: date
    start: str
    end: str
    title: str


def planned_slots(blocks) -> dict[str, tuple[PlannedSlot, ...]]:
    """Planner-placed task blocks grouped by goal, from decoded `calendar_blocks.data` dicts.

    Only `placed_by == "planner"` counts: the user's own blocks never move, so they are
    not what a re-plan's audit row is describing.
    """
    out: dict[str, list[PlannedSlot]] = {}
    for data in blocks:
        if data.get("block_kind") != "task" or data.get("placed_by") != "planner":
            continue
        goal_id, day = data.get("goal_id"), data.get("day")
        if not goal_id or not day:
            continue
        out.setdefault(goal_id, []).append(
            PlannedSlot(
                day=date.fromisoformat(day) if isinstance(day, str) else day,
                start=str(data.get("start") or "")[:5],
                end=str(data.get("end") or "")[:5],
                title=data.get("title") or "",
            )
        )
    return {goal_id: tuple(slots) for goal_id, slots in out.items()}


def committed_events(blocks) -> tuple[PlannedSlot, ...]:
    """User events that could be the reason a session moved, from decoded block dicts."""
    out: list[PlannedSlot] = []
    for data in blocks:
        if data.get("block_kind") != "event":
            continue
        day, start, end = data.get("day"), data.get("start"), data.get("end")
        if not day or not start or not end:
            continue
        out.append(
            PlannedSlot(
                day=date.fromisoformat(day) if isinstance(day, str) else day,
                start=str(start)[:5],
                end=str(end)[:5],
                title=data.get("title") or "",
            )
        )
    return tuple(out)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def movement_summary(
    goal_title: str,
    before: tuple[PlannedSlot, ...],
    after: tuple[PlannedSlot, ...],
    events: tuple[PlannedSlot, ...] = (),
) -> str | None:
    """One sentence for the audit row: what the re-plan moved, and why when a user event forced it.

    Counts sessions per day rather than by id: a re-plan mints new block ids every time,
    so ids would call every session moved. The day counts are stable and are what the
    user sees.
    """
    was, now = Counter(s.day for s in before), Counter(s.day for s in after)
    removed = {day: was[day] - now[day] for day in was if was[day] > now[day]}
    if not removed:
        added = sum(max(0, count - was[day]) for day, count in now.items())
        if not added:
            return None
        return f"Scheduled {_plural(added, 'session')} for '{goal_title}'"

    day = max(removed, key=lambda d: (removed[d], -d.toordinal()))
    # Only the named day's count: "Moved 3 off Tue" must be true of Tuesday, even when a
    # session also left another day.
    total = removed[day]
    slots = [s for s in before if s.day == day]
    reason = next(
        (
            event.title
            for event in events
            if event.day == day
            and any(s.start < event.end and event.start < s.end for s in slots)
        ),
        "",
    )
    line = f"Moved {_plural(total, 'session')} for '{goal_title}' off {day:%a}"
    return f"{line}: {reason}" if reason else line


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------


async def _queued_id(session: AsyncSession, *, user_id: str, key: str) -> str | None:
    return (
        await session.execute(
            select(AgentJob.id).where(
                AgentJob.user_id == user_id,
                AgentJob.dedupe_key == key,
                AgentJob.status == JOB_QUEUED,
            )
        )
    ).scalar_one_or_none()


async def enqueue(
    session: AsyncSession,
    *,
    user_id: str,
    kind: str,
    goal_id: str | None = None,
    run_after: datetime | None = None,
) -> str:
    """Queue one job **in the caller's transaction**, returning its id.

    A job that is already queued for the same work returns that id instead of a second
    row, so a double tap is one job. The partial unique index is the backstop for two
    requests racing between the SELECT and the INSERT.
    """
    if kind not in JOB_KINDS:
        raise ValueError(f"unknown job kind: {kind}")
    key = dedupe_key_for(kind, goal_id)
    existing = await _queued_id(session, user_id=user_id, key=key)
    if existing:
        return existing

    job = AgentJob(
        id=new_id("job"),
        user_id=user_id,
        kind=kind,
        goal_id=goal_id,
        dedupe_key=key,
        status=JOB_QUEUED,
        attempts=0,
        run_after=run_after or _now(),
        progress="",
    )
    try:
        async with session.begin_nested():
            session.add(job)
            await session.flush()
    except IntegrityError:
        # Lost a race with another enqueue; that request's job is the one that will run.
        existing = await _queued_id(session, user_id=user_id, key=key)
        if existing:
            return existing
        raise
    return job.id


# ---------------------------------------------------------------------------
# Claim
# ---------------------------------------------------------------------------


async def recover_expired(session: AsyncSession, now: datetime | None = None) -> int:
    """Requeue or fail jobs whose worker died while holding the lease. Returns how many moved."""
    now = _utc(now or _now())
    rows = list(
        (
            await session.execute(
                select(AgentJob)
                .where(
                    AgentJob.status == JOB_RUNNING,
                    or_(AgentJob.lease_until.is_(None), AgentJob.lease_until <= now),
                )
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    for job in rows:
        job.lease_until = None
        job.updated_at = now
        if job.goal_id and job.kind in GOAL_PLAN_JOBS:
            # The worker is gone, so no build is running. `planning` would otherwise block every
            # later attempt until the plan lease ran out.
            goal = await session.get(Goal, job.goal_id)
            if goal is not None and goal.plan_status == PLAN_PLANNING:
                goal.plan_status = PLAN_FAILED
        if lease_outcome(job.attempts, settings.job_max_attempts) == JOB_FAILED:
            job.status = JOB_FAILED
            job.error = "The worker stopped before the job finished."
        else:
            job.status = JOB_QUEUED
            job.run_after = now + timedelta(seconds=settings.job_retry_delay_seconds)
    return len(rows)


async def claim(
    session: AsyncSession, *, user_id: str | None = None, now: datetime | None = None
) -> str | None:
    """Take one due job, or `None`.

    At most one job per user is running: the `NOT EXISTS` is what keeps a second request
    from starting the same user's next job while the first is still building a plan.
    `SKIP LOCKED` lets two workers drain different users concurrently without waiting.
    """
    now = _utc(now or _now())
    await recover_expired(session, now)

    running = aliased(AgentJob)
    conditions = [
        AgentJob.status == JOB_QUEUED,
        AgentJob.run_after <= now,
        ~exists().where(
            running.user_id == AgentJob.user_id,
            running.status == JOB_RUNNING,
            running.id != AgentJob.id,
        ),
    ]
    if user_id:
        conditions.append(AgentJob.user_id == user_id)
    stmt = (
        select(AgentJob)
        .where(*conditions)
        .order_by(AgentJob.run_after.asc(), AgentJob.created_at.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    job = (await session.execute(stmt)).scalar_one_or_none()
    if job is None:
        await session.commit()  # still persist any lease recovery above
        return None
    job.status = JOB_RUNNING
    job.attempts += 1
    job.lease_until = now + timedelta(seconds=settings.job_lease_seconds)
    job.progress = ""
    job.error = None
    job.updated_at = now
    try:
        await session.commit()
    except IntegrityError:
        # Another claim started this user's job first (agent_jobs_one_running_idx). Leave this one
        # queued; it runs once that one finishes.
        await session.rollback()
        return None
    return job.id


# ---------------------------------------------------------------------------
# Running one job
# ---------------------------------------------------------------------------


@dataclass
class JobResult:
    """What `run` tells its caller, and what a client sees on `/state`."""

    id: str
    kind: str
    goal_id: str | None
    status: str
    summary: str = ""
    audit_id: str | None = None
    error: str = ""


class JobFailed(Exception):
    """A job's work was refused (not a programming error). Retried, then shown to the user."""


def _short_error(exc: Exception) -> str:
    text = str(exc).strip() or exc.__class__.__name__
    return text[:JOB_ERROR_MAX_CHARS]


async def set_progress(job_id: str, line: str) -> None:
    """Persist a progress line. Its own short transaction, so it is visible while the model works."""
    try:
        async with _maker()() as session:
            await session.execute(
                AgentJob.__table__.update()
                .where(AgentJob.id == job_id)
                .values(progress=line, updated_at=_now())
            )
            await session.commit()
    except Exception:  # noqa: BLE001 - a progress write must never fail the job
        log.debug("could not write progress for %s", job_id, exc_info=True)


def _say_with_progress(job_id: str, say) -> tuple:
    """Wrap `say` so every line goes both to the caller (SSE) and onto the job row.

    The planner reports progress from a worker thread (`asyncio.to_thread`), so the
    database write is handed back to the event loop with `run_coroutine_threadsafe`.
    """
    loop = asyncio.get_running_loop()

    def note(line: str) -> None:
        say(line)
        asyncio.run_coroutine_threadsafe(set_progress(job_id, line), loop)

    return note


async def _goal_facts(session: AsyncSession, *, user_id: str, goal_id: str) -> GoalFacts | None:
    goal = await repo.get_goal(session, user_id=user_id, goal_id=goal_id)
    if goal is None:
        return None
    rows = (
        await session.execute(
            select(Milestone.id, Milestone.target_date).where(
                Milestone.user_id == user_id,
                Milestone.goal_id == goal_id,
                Milestone.status != "done",
            )
        )
    ).all()
    return GoalFacts(
        target_date=goal.target_date,
        weekly_hours=goal.weekly_hours,
        milestones=frozenset((mid, target) for mid, target in rows),
    )


async def _block_data(session: AsyncSession, *, user_id: str) -> list[dict]:
    rows = (
        await session.execute(
            select(CalendarBlock.data).where(
                CalendarBlock.user_id == user_id,
                CalendarBlock.block_kind.in_(("task", "event")),
            )
        )
    ).scalars()
    return [data or {} for data in rows]


async def _goal_titles(session: AsyncSession, *, user_id: str) -> dict[str, str]:
    rows = (await session.execute(select(Goal.id, Goal.title).where(Goal.user_id == user_id))).all()
    return dict(rows)


def _plan_failure(out) -> str:
    """The sentence a rejected planner outcome carries into the job's error."""
    violations = getattr(out, "violations", ()) or ()
    if violations:
        return "; ".join(getattr(v, "message", str(v)) for v in violations)
    return "The plan did not pass validation."


async def _run_plan_job(session: AsyncSession, job: AgentJob, say) -> JobResult:
    """Plan or re-plan one goal, then apply it or propose what would change its facts."""
    from .api.plan import _set_plan_status, build_in_flight

    now = local_now()
    goal = await repo.get_goal(session, user_id=job.user_id, goal_id=job.goal_id or "")
    if goal is None or goal.status != "active":
        return JobResult(job.id, job.kind, job.goal_id, JOB_DONE, "That goal is no longer active.")

    # A retry (attempts > 1) finds the `planning` its own killed first attempt left behind: the job lease
    # is shorter than the build lease, so that status is ours, not another build's, and must not stop us.
    if job.attempts <= 1 and build_in_flight(goal.plan_status, goal.plan_started_at, now):
        # Another request owns the build; it will write the same plan. Do not race it.
        return JobResult(job.id, job.kind, job.goal_id, JOB_DONE, "A build is already running.")

    facts = await _goal_facts(session, user_id=job.user_id, goal_id=goal.id)
    if facts is None:
        return JobResult(job.id, job.kind, job.goal_id, JOB_DONE, "That goal no longer exists.")

    say(BUILD_FIRST)
    await _set_plan_status(session, goal, PLAN_PLANNING)

    store = SqlStore(session, job.user_id, today=now.date())
    found = await replan_preview(store, goal.id, now=now, progress=say)
    if found is None:
        goal.plan_status = PLAN_READY
        return JobResult(job.id, job.kind, job.goal_id, JOB_DONE, "Nothing left to plan for this goal.")

    changes, notes = found
    origin = Origin(source="goal", ref=goal.id)
    if not keeps_goal_facts(facts, changes, goal.id):
        # The rule: nothing applied, the change becomes a proposal.
        proposed = fact_changes(facts, changes, goal.id) or list(changes)
        for change in proposed:
            await store.add_proposal(change, FACT_PROPOSAL_REASON, origin)
        goal.plan_status = PLAN_READY
        summary = f"Proposed {len(proposed)} change(s) to '{goal.title}' for you to confirm."
        return JobResult(job.id, job.kind, job.goal_id, JOB_DONE, summary)

    titles = await _goal_titles(session, user_id=job.user_id)
    blocks = await _block_data(session, user_id=job.user_id)
    before_slots = planned_slots(blocks).get(goal.id, ())
    events = committed_events(blocks)

    res = await apply_changes(store, ChangeSet(origin=origin, changes=changes))
    if isinstance(res, Rejected):
        raise JobFailed(_plan_failure(res))

    after_slots = planned_slots(await _block_data(session, user_id=job.user_id)).get(goal.id, ())
    summary = movement_summary(titles.get(goal.id, goal.title), before_slots, after_slots, events)
    if summary and res.audit_id:
        row = await session.get(AuditEntry, res.audit_id)
        if row is not None:
            row.summary = summary
    goal.plan_status = PLAN_READY
    await staleness.mark_planned(session, user_id=job.user_id, goal_id=goal.id)
    if job.kind == JOB_BUILD_PLAN and not summary:
        summary = f"Planned '{goal.title}'."
    return JobResult(
        job.id, job.kind, job.goal_id, JOB_DONE,
        summary or "; ".join(notes[:1]) or "Re-planned.",
        audit_id=res.audit_id,
    )


async def _annotate_new_audits(
    session: AsyncSession, *, user_id: str, started_at: datetime, before: dict, events: tuple, titles: dict
) -> None:
    """Rewrite the summaries of the audit rows a multi-goal job just wrote.

    `replan_conflicts` and `tick` apply through the gateway one goal at a time, so each
    goal already has its own `agent:apply` row. This gives each the movement sentence
    instead of the gateway's "N applied" — one row per goal, undoable as before.
    """
    rows = list(
        (
            await session.execute(
                select(AuditEntry).where(
                    AuditEntry.user_id == user_id,
                    AuditEntry.type == AUDIT_APPLY,
                    AuditEntry.created_at >= started_at,
                )
            )
        ).scalars()
    )
    if not rows:
        return
    after = planned_slots(await _block_data(session, user_id=user_id))
    for row in rows:
        goal_id = ((row.payload or {}).get("origin") or {}).get("ref")
        if not goal_id:
            continue
        summary = movement_summary(
            titles.get(goal_id, ""), before.get(goal_id, ()), after.get(goal_id, ()), events
        )
        if summary:
            row.summary = summary


async def _run_conflict_job(session: AsyncSession, job: AgentJob, say) -> JobResult:
    """Plan again any goal whose time now collides with the user's fixed commitments."""
    # Imported here: `plan_guard` imports `api.plan`, which imports this module.
    from .plan_guard import guarded, live_builds

    now = local_now()
    started_at = _now()
    titles = await _goal_titles(session, user_id=job.user_id)
    blocks = await _block_data(session, user_id=job.user_id)
    before = planned_slots(blocks)
    events = committed_events(blocks)

    live = await live_builds(session, user_id=job.user_id, now=now)
    say(CONFLICT_FIRST)
    out = await replan_conflicts(
        guarded(SqlStore(session, job.user_id, today=now.date()), live), now=now
    )
    if out.status != "applied":
        raise JobFailed(_plan_failure(out))

    await _annotate_new_audits(
        session, user_id=job.user_id, started_at=started_at, before=before, events=events, titles=titles
    )
    summary = "; ".join(n for n in out.notes if n != "no conflicts") or "No conflicts to fix."
    return JobResult(job.id, job.kind, None, JOB_DONE, summary)


async def _run_tick_job(session: AsyncSession, job: AgentJob, say) -> JobResult:
    """The nightly tick, now caused by a queue row instead of a long cron request."""
    from .plan_guard import guarded, live_builds

    now = local_now()
    started_at = _now()
    titles = await _goal_titles(session, user_id=job.user_id)
    blocks = await _block_data(session, user_id=job.user_id)
    before = planned_slots(blocks)
    events = committed_events(blocks)

    live = await live_builds(session, user_id=job.user_id, now=now)
    say(TICK_FIRST)
    out = await tick(guarded(SqlStore(session, job.user_id, today=now.date()), live), now=now)

    await _annotate_new_audits(
        session, user_id=job.user_id, started_at=started_at, before=before, events=events, titles=titles
    )
    summary = "; ".join(out.notes[:3]) or "Nothing to do."
    return JobResult(job.id, job.kind, None, JOB_DONE, summary)


async def _fail_or_retry(job_id: str, exc: Exception) -> str:
    """Record a failed attempt: back to the queue while attempts remain, else failed for good."""
    async with _maker()() as session:
        job = await session.get(AgentJob, job_id)
        if job is None:
            return JOB_FAILED
        now = _now()
        job.lease_until = None
        job.error = _short_error(exc)
        job.updated_at = now
        if job.goal_id and job.kind in GOAL_PLAN_JOBS:
            # Whatever comes next, the build is not running: leaving `planning` would make the
            # retry (and any other request) see a live build and step aside until the lease
            # times out, and the goal card would claim work that is not happening.
            goal = await session.get(Goal, job.goal_id)
            if goal is not None:
                goal.plan_status = PLAN_FAILED
        if lease_outcome(job.attempts, settings.job_max_attempts) == JOB_FAILED:
            job.status = JOB_FAILED
            job.progress = ""
        else:
            job.status = JOB_QUEUED
            job.run_after = now + timedelta(seconds=settings.job_retry_delay_seconds)
        await session.commit()
        return job.status


async def run(job_id: str, *, say=None) -> JobResult | None:
    """Run one claimed job. The caller must have set it `running` and hold its lease."""
    say = _say_with_progress(job_id, say or (lambda _line: None))
    async with _maker()() as session:
        job = await session.get(AgentJob, job_id)
        if job is None or job.status != JOB_RUNNING:
            return None
        log.info("job %s: %s for %s", job.id, job.kind, job.user_id)
        try:
            if job.kind in GOAL_PLAN_JOBS:
                result = await _run_plan_job(session, job, say)
            elif job.kind == JOB_REPLAN_CONFLICTS:
                result = await _run_conflict_job(session, job, say)
            elif job.kind == JOB_TICK_USER:
                result = await _run_tick_job(session, job, say)
            else:
                raise JobFailed(f"Unknown job kind: {job.kind}")
        except Exception as exc:  # noqa: BLE001 - the failure ladder: a job never 500s
            await session.rollback()
            log.warning("job %s failed: %s", job_id, exc)
            status = await _fail_or_retry(job_id, exc)
            return JobResult(job_id, job.kind, job.goal_id, status, error=_short_error(exc))

        job.status = result.status
        job.lease_until = None
        job.progress = result.summary
        job.error = result.error or None
        job.audit_id = result.audit_id
        job.result = {
            "summary": result.summary,
            "audit_id": result.audit_id,
            "applied": getattr(result, "applied", 0),
        }
        job.updated_at = _now()
        await session.commit()
        return result


async def _claim_one(*, user_id: str | None = None) -> str | None:
    async with _maker()() as session:
        return await claim(session, user_id=user_id)


async def run_user_jobs(user_id: str, say=None) -> dict:
    """Drain one user's due jobs. At most one runs at a time, enforced by `claim`."""
    results: list[dict] = []
    while (job_id := await _claim_one(user_id=user_id)) is not None:
        result = await run(job_id, say=say)
        if result is None:
            break
        results.append(
            {
                "id": result.id, "kind": result.kind, "goal_id": result.goal_id,
                "status": result.status, "summary": result.summary,
                "audit_id": result.audit_id, "error": result.error,
            }
        )
        if result.status == JOB_QUEUED:
            # It exhausted this attempt and waits for its retry delay; do not spin on it.
            break
    return {"ran": len(results), "jobs": results}


async def run_due_jobs(say=None, *, budget_seconds: int | None = None) -> dict:
    """Drain everyone's due jobs inside a wall-clock budget (the cron route's work).

    The budget is checked between jobs, so one slow plan may overrun it; the next drain
    picks up whatever is left. A claim makes two concurrent drains take different rows.
    """
    deadline = monotonic() + (budget_seconds or settings.cron_jobs_budget_seconds)
    results: list[dict] = []
    while monotonic() < deadline:
        job_id = await _claim_one()
        if job_id is None:
            break
        result = await run(job_id, say=say)
        if result is None:
            break
        results.append({"id": result.id, "kind": result.kind, "status": result.status})
    return {"ran": len(results), "jobs": results}


# ---------------------------------------------------------------------------
# `/state`
# ---------------------------------------------------------------------------


async def list_jobs(session: AsyncSession, *, user_id: str, now: datetime | None = None) -> list[dict]:
    """The jobs the app should show: everything active, plus recently finished ones.

    Finished rows stay for `jobs_recent_minutes` so a toast and its Undo survive a
    refresh; the cap keeps a long-running user's payload small.
    """
    now = _utc(now or _now())
    cutoff = now - timedelta(minutes=settings.jobs_recent_minutes)
    rows = list(
        (
            await session.execute(
                select(AgentJob)
                .where(
                    AgentJob.user_id == user_id,
                    or_(
                        AgentJob.status.in_((JOB_QUEUED, JOB_RUNNING)),
                        AgentJob.updated_at >= cutoff,
                    ),
                )
                .order_by(AgentJob.updated_at.desc())
                .limit(settings.jobs_report_limit)
            )
        ).scalars()
    )
    titles = await _goal_titles(session, user_id=user_id)
    return [
        {
            "id": job.id,
            "kind": job.kind,
            "goal_id": job.goal_id,
            "goal_title": titles.get(job.goal_id or "", ""),
            "status": job.status,
            "progress": job.progress,
            "audit_id": job.audit_id,
            "error": job.error,
            "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        }
        for job in rows
    ]
