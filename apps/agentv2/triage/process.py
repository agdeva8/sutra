"""One Scratch entry, start to finish: read it, route it, apply it, say what happened.

This is the function the API calls. It never raises on a model or routing
failure: the worst outcome is a status of `failed` or `needs_input`, with the
entry's own words untouched (HLD §10).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime

from ..contracts import (
    AddBlock, AddRecurring, StopRecurring, ClearGoalPlan, CompleteItem, AddGoal, AddMilestone, AddPlanWeek, AddReminder, AddTask, Applied, Change, LinkSource, MoveBlock, Origin, Rejected,
)
from ..gateway import Store, apply
from ..llm import Image
from .classify import classify
from .route import route

HANDLED = "handled"
NEEDS_INPUT = "needs_input"
FAILED = "failed"

MSG_UNREADABLE = "Couldn't read this. Try again."
MSG_REJECTED = "Couldn't file this safely."


@dataclass
class Outcome:
    status: str
    #: The one question to ask, for `needs_input`.
    question: str | None = None
    #: What the agent did, one line per change, for the Handled card.
    lines: list[str] = field(default_factory=list)
    #: The triage bucket, for the card's kind label.
    bucket: str | None = None
    error: str | None = None
    #: True when a change was held as a proposal instead of applied.
    proposed: bool = False
    #: Goals whose planned time a fixed block displaced; the caller replans them.
    displaced_goals: list[str] = field(default_factory=list)


def describe(c: Change) -> str:
    if isinstance(c, AddGoal):
        return f"New goal: {c.title}"
    if isinstance(c, AddTask):
        return f"New task: {c.title} ({c.effort_hours:g}h)"
    if isinstance(c, AddReminder):
        times = ", ".join(t.strftime("%H:%M") for t in c.times)
        return f"Reminder: {c.title} on {len(c.days)} day(s) at {times}"
    if isinstance(c, AddBlock):
        return f"{'Fixed' if c.status == 'committed' else 'Planned'}: {c.title}, {c.day:%a %d %b} {c.start:%H:%M}-{c.end:%H:%M}"
    if isinstance(c, AddRecurring):
        days = ", ".join(("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[d] for d in c.weekdays)
        until = f" until {c.end_date:%d %b}" if c.end_date else ""
        return f"Repeating: {c.title}, {days} {c.start:%H:%M}-{c.end:%H:%M}{until}"
    if isinstance(c, StopRecurring):
        return f"Stopped repeating: {c.title or 'a commitment'}, from {c.from_date:%d %b}"
    if isinstance(c, ClearGoalPlan):
        return f"Cleared the open plan from {c.from_date:%d %b} to plan it again"
    if isinstance(c, CompleteItem):
        return f"Marked done: {c.title}"
    if isinstance(c, AddMilestone):
        return f"Milestone: {c.title} by {c.target_date:%d %b %Y}"
    if isinstance(c, AddPlanWeek):
        return f"Week of {c.week_start:%d %b}: {c.focus} ({c.hours:g}h)"
    if isinstance(c, LinkSource):
        return f"Kept in Sources: {c.title}"
    if isinstance(c, MoveBlock):
        return f"Move block to {c.day:%a %d %b} {c.start:%H:%M}-{c.end:%H:%M}"
    return c.kind


async def process_entry(
    chat, store: Store, text: str, now: datetime, origin: Origin,
    images: list[Image] | None = None, source_id: str | None = None,
) -> Outcome:
    ctx = await store.context()
    # Model calls block, so they run in a thread rather than freezing the server.
    result = await asyncio.to_thread(classify, chat, text, ctx, now, images)
    if result is None:
        return Outcome(FAILED, error=MSG_UNREADABLE)

    routed = await asyncio.to_thread(route, chat, result, ctx, now, origin, source_id)
    if routed.waiting:
        return Outcome(NEEDS_INPUT, question=routed.waiting, bucket=result.bucket_label)
    if routed.changeset is None:  # noise
        return Outcome(HANDLED, bucket=result.bucket_label, lines=routed.notes or ["Kept as a note"])

    res = await apply(routed.changeset, store)
    if isinstance(res, Rejected):
        return Outcome(FAILED, error=MSG_REJECTED, bucket=result.bucket_label)
    assert isinstance(res, Applied)
    lines = [describe(c) for i, c in enumerate(routed.changeset.changes) if i in set(res.applied)]
    lines += [f"Needs your OK: {describe(routed.changeset.changes[p.change_index])} ({p.reason})" for p in res.proposed]
    lines += routed.notes
    return Outcome(HANDLED, bucket=result.bucket_label, lines=lines, proposed=bool(res.proposed), displaced_goals=res.displaced_goals)
