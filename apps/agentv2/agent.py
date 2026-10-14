"""The public surface of agentv2: plain functions for the business logic to call.

agentv2 is a library. It exposes no HTTP and holds no database driver: the caller
passes in a `Store` (the SQL one lives in `apps/api`) and gets typed results back.
Everything else in this package is internal and may change.

    from agentv2 import triage_entry, plan_goals, apply_changes
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import asyncio

from .config import PROGRESS_APPLY, REPLAN_DRIFT_HOURS, load_settings
from .core.calendar import week_start
from .core.clock import local_now
from .contracts import Applied, ChangeSet, Origin, Rejected, Violation
from .contracts.intake import GoalDraft, IntakeState
from .contracts.planner import GoalSpec
from .chatplan import chat_turn as _chat_turn
from .contracts.chatplan import ChatTurn
from .entrychat import ChatStep, entry_chat as _entry_chat
from .intake import IntakeStep, draft_to_changes, intake_turn as _intake_turn
from .gateway import Store, UndoResult, apply, undo
from .llm import Image
from .model import build_model
from .planner.plan import plan_goals as _plan_goals
from .planner.replan import replan_changes
from .planner.tick import tick_changes
from .triage.process import Outcome, process_entry

ORIGIN_SCRATCH = "scratch"
ORIGIN_GOAL = "goal"
ORIGIN_TICK = "tick"


class ModelUnavailable(RuntimeError):
    """No model is configured (no API key). A normal error, so a request or background task fails cleanly
    instead of the process exiting."""


def default_chat():
    """The configured model (see `config.py`). Built on demand, so importing agentv2 needs no key."""
    try:
        settings = load_settings()
    except SystemExit as e:  # load_settings exits when the key is missing; a library must not
        raise ModelUnavailable(str(e)) from None
    return build_model(settings)


async def triage_entry(
    store: Store,
    text: str,
    *,
    entry_id: str | None = None,
    images: list[Image] | None = None,
    source_id: str | None = None,
    now: datetime | None = None,
    tz: str | None = None,
    chat=None,
) -> Outcome:
    """File one Scratch note and/or photo. Never raises on a model or routing failure:
    the result's `status` is `handled`, `needs_input` or `failed`."""
    chat = chat or default_chat()
    now = now or local_now(tz)
    out = await process_entry(chat, store, text, now, Origin(source=ORIGIN_SCRATCH, ref=entry_id), images, source_id)
    # A fixed block that covered planned time: plan those goals again around it.
    for goal_id in out.displaced_goals:
        res = await replan_goal(store, goal_id, now=now, chat=chat)
        title = (await store.context()).goal_titles.get(goal_id, "your plan")
        out.lines.append(f"Moved {title} sessions that overlapped it" if res.status == "applied" else f"Couldn't re-plan {title}")
    return out


@dataclass
class PlanOutcome:
    status: str  # "applied" | "rejected"
    notes: list[str] = field(default_factory=list)
    applied: int = 0
    proposed: int = 0
    violations: list[Violation] = field(default_factory=list)


async def plan_goals(
    store: Store, goals: list[GoalSpec], *, now: datetime | None = None, tz: str | None = None, chat=None, ref: str | None = None, progress=None
) -> PlanOutcome:
    """Plan one or more goals together and write the result through the gateway."""
    now = now or local_now(tz)
    cs, notes = await _plan_goals(chat or default_chat(), goals, await store.context(), now, Origin(source=ORIGIN_GOAL, ref=ref), progress)
    if progress:
        progress(PROGRESS_APPLY)
    res = await apply(cs, store)
    if isinstance(res, Rejected):
        return PlanOutcome("rejected", notes, violations=res.violations)
    assert isinstance(res, Applied)
    return PlanOutcome("applied", notes, applied=len(res.applied), proposed=len(res.proposed))


async def intake_turn(state: IntakeState | None, user_text: str, *, now: datetime | None = None, tz: str | None = None, chat=None) -> IntakeStep:
    """One turn of goal intake. Returns a question (with the new `state` to keep) or a `draft`.
    Stateless: the caller stores `step.state` and passes it back with the user's next answer."""
    # The model call blocks, so it runs in a thread rather than freezing the server.
    return await asyncio.to_thread(_intake_turn, chat or default_chat(), state, user_text, now or local_now(tz))


@dataclass
class GoalCreated:
    goal_id: str
    plan: PlanOutcome


async def create_goal(
    store: Store, draft: GoalDraft, *, now: datetime | None = None, tz: str | None = None, chat=None, priority: int = 1, progress=None
) -> GoalCreated:
    """Write a confirmed draft (goal + milestones), then plan it. Call inside one transaction."""
    now = now or local_now(tz)
    spec, changes = draft_to_changes(draft, now, priority=priority)
    res = await apply(ChangeSet(origin=Origin(source=ORIGIN_GOAL, ref=spec.id), changes=changes), store)
    if isinstance(res, Rejected):
        return GoalCreated(spec.id, PlanOutcome("rejected", violations=res.violations))
    return GoalCreated(spec.id, await plan_goals(store, [spec], now=now, chat=chat, ref=spec.id, progress=progress))


async def entry_chat(
    store: Store, note: str, turns: list[tuple[str, str]], user_message: str, *, chat=None
) -> ChatStep:
    """One turn of the chat about an entry the intake was unsure of. When `step.resolved` is set,
    pass that text to `triage_entry` to file it."""
    return await asyncio.to_thread(_entry_chat, chat or default_chat(), note, turns, user_message, await store.context())


async def chat_turn(
    store: Store, message: str, *, history: list[tuple[str, str]] | None = None,
    now: datetime | None = None, tz: str | None = None, chat=None, ref: str | None = None,
) -> ChatTurn:
    """One coach-chat message. Files what it can (through the gateway), proposes goal and availability
    changes for the user to confirm, and returns `kind="not_planned"` when the ordinary chat should answer."""
    return await _chat_turn(chat or default_chat(), store, message, history or [], now or local_now(tz), Origin(source="chat", ref=ref))


async def goal_progress(store: Store, *, now: datetime | None = None, tz: str | None = None) -> list[dict]:
    """Per goal: hours needed, done, still to do, and still planned from this week on."""
    now = now or local_now(tz)
    ctx = await store.context()
    this_week = week_start(now.date())
    return [
        {"goal_id": g, "title": ctx.goal_titles.get(g, g), "total": h.total, "done": round(h.done, 2), "remaining": round(h.remaining, 2),
         "planned": round(sum(w.hours for w in ctx.plan_weeks if w.goal_id == g and w.week_start >= this_week), 2)}
        for g, h in ctx.goal_hours.items()
    ]


async def tick(store: Store, *, now: datetime | None = None, tz: str | None = None, chat=None) -> PlanOutcome:
    """The nightly job for one user: expand any plan week that has come into the day window."""
    now = now or local_now(tz)
    chat = chat or default_chat()
    notes: list[str] = []

    # 1. keep recurring commitments laid out to the horizon, and plan around anything they now cover
    added = await store.extend_recurring(now.date())
    if added:
        notes.append(f"laid out {added} more recurring block(s)")
        await replan_conflicts(store, now=now, chat=chat)

    # 2. give day-level detail to weeks that came into the window
    changes, expand_notes = await asyncio.to_thread(tick_changes, chat, await store.context(), now)
    notes += expand_notes
    applied = proposed = 0
    if changes:
        res = await apply(ChangeSet(origin=Origin(source=ORIGIN_TICK), changes=changes), store)
        if isinstance(res, Rejected):
            return PlanOutcome("rejected", notes, violations=res.violations)
        applied, proposed = len(res.applied), len(res.proposed)

    # 3. progress feedback: if what is still planned has drifted from what is still to do (a missed week, or
    #    work finished early), plan that goal again
    ctx = await store.context()
    this_week = week_start(now.date())
    for g, h in ctx.goal_hours.items():
        planned = sum(w.hours for w in ctx.plan_weeks if w.goal_id == g and w.week_start >= this_week)
        if h.remaining > 0 and abs(h.remaining - planned) > REPLAN_DRIFT_HOURS:
            out = await replan_goal(store, g, now=now, chat=chat)
            notes.append(f"{ctx.goal_titles.get(g, g)}: {h.remaining:g}h to do but {planned:g}h planned, replanned ({out.status})")
            applied += out.applied
    return PlanOutcome("applied", notes or ["nothing to do"], applied=applied, proposed=proposed)


async def replan_goal(
    store: Store, goal_id: str, *, now: datetime | None = None, tz: str | None = None, chat=None, progress=None
) -> PlanOutcome:
    """Plan one goal again around what is on the calendar now (after a new commitment, an away
    stretch, a moved deadline). Only the agent's own planned time is replaced."""
    now = now or local_now(tz)
    found = await asyncio.to_thread(replan_changes, chat or default_chat(), await store.context(), goal_id, now, progress)
    if found is None:
        return PlanOutcome("applied", ["nothing left to plan for this goal"])
    changes, notes = found
    if progress:
        progress(PROGRESS_APPLY)
    res = await apply(ChangeSet(origin=Origin(source=ORIGIN_GOAL, ref=goal_id), changes=changes), store)
    if isinstance(res, Rejected):
        return PlanOutcome("rejected", notes, violations=res.violations)
    return PlanOutcome("applied", notes, applied=len(res.applied), proposed=len(res.proposed))


async def replan_conflicts(store: Store, *, now: datetime | None = None, tz: str | None = None, chat=None) -> PlanOutcome:
    """Plan again any goal whose planned time now collides with something fixed (a commitment added in
    the app, or an away stretch). Safe to call after any change to the calendar: with no conflict it does nothing."""
    now = now or local_now(tz)
    ctx = await store.context()
    hit = [b for b in ctx.blocks if b.status == "tentative" and b.goal_id and b.day >= now.date()
           and (b.day in ctx.blocked_dates or any(
               o.status == "committed" and o.day == b.day and b.start < o.end and o.start < b.end for o in ctx.blocks))]
    if not hit:
        return PlanOutcome("applied", ["no conflicts"])
    await store.remove_blocks([b.id for b in hit])
    notes: list[str] = []
    for goal_id in sorted({b.goal_id for b in hit}):
        res = await replan_goal(store, goal_id, now=now, chat=chat)
        notes += [f"{ctx.goal_titles.get(goal_id, goal_id)}: {n}" for n in res.notes[:1]]
        if res.status != "applied":
            return PlanOutcome("rejected", notes, violations=res.violations)
    return PlanOutcome("applied", notes)


async def undo_audit(store: Store, audit_id: str) -> UndoResult:
    """Reverse what one audit row applied (the card's Undo)."""
    return await undo(store, audit_id)


async def apply_changes(store: Store, changes: ChangeSet, *, approved: bool = False) -> Applied | Rejected:
    """The gateway: validate, apply what is safe, propose what is not, audit. Pass `approved=True` for
    changes the user has confirmed."""
    return await apply(changes, store, approved=approved)
