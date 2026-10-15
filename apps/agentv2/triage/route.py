"""From a `TriageResult` to a `ChangeSet` the gateway can take, or to "ask the user".

One entry can hold several items (a photo of a prescription lists two medicines;
a whiteboard is a source plus some actions). Each item becomes its own change;
the items that cannot be filed yet contribute a question instead. Every date comes
from code (`core.dates`, `core.recur`, `core.slots`); the model's output is only meaning.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta

from ..config import BLOCK_COMMITTED, DEFAULT_BLOCK_MINUTES, MAX_AWAY_DAYS, TRIAGE_CONFIDENCE_MIN
from ..contracts import AddBlocker, AddRecurring, StopRecurring, CompleteItem, AddBlock, AddGoal, AddReminder, AddTask, Change, ChangeSet, LinkSource, Origin
from ..contracts.triage import ReminderSpec, TriageItem, TriageResult
from ..core.context import BlockRow, Context
from ..core.dates import WEEKDAYS, parse_date, parse_hhmm
from ..core.ids import new_id
from ..core.recur import expand_reminder
from .place import place_task


@dataclass
class Routed:
    changeset: ChangeSet | None = None
    #: Set when nothing could be filed and the entry should wait for the user.
    waiting: str | None = None
    notes: list[str] = field(default_factory=list)


def _item(chat, it: TriageItem, ctx: Context, now: datetime, source_id: str | None, from_image: bool = False):
    """(changes, note, question) for one item."""
    if it.bucket == "noise":
        return [], None, None

    if it.bucket == "goal":
        return [AddGoal(id=new_id("goal"), title=it.title)], "goal created; intake (step 4) will ask for milestones and a deadline", None

    if it.bucket == "done" and from_image:
        return [], "Ignored a \"done\" found inside a photo: tell me in a message if something is finished", None

    if it.bucket == "done":
        if not it.target_id or it.target_id not in ctx.open_items:
            return [], None, f"Which one did you finish? I couldn't match “{it.title}”."
        outcome = it.outcome if it.outcome != "partial" or (it.fraction and 0 < it.fraction < 1) else "full"
        frac = it.fraction if outcome == "partial" else None
        return [CompleteItem(item_id=it.target_id, title=ctx.open_items[it.target_id], outcome=outcome, fraction=frac)], None, None

    if it.bucket == "away":
        a = it.away
        first = parse_date(a.start_date, now.date()) if a else None
        last = (parse_date(a.end_date, now.date()) if a.end_date else first) if a else None
        if first is None or last is None or last < first:
            return [], None, f"Which days are you away for “{it.title}”?"
        if last < now.date():
            return [], None, f"“{it.title}” is on days that have already passed. Which days did you mean?"
        if (last - first).days >= MAX_AWAY_DAYS:
            return [], None, f"That is more than {MAX_AWAY_DAYS} days. When exactly are you away for “{it.title}”?"
        return [AddBlocker(id=new_id("away"), title=it.title, start_date=first, end_date=last)], None, None

    if it.bucket == "recurring":
        r = it.recurring
        days = sorted({WEEKDAYS.index(w.strip().lower()) for w in (r.weekdays if r else []) if w.strip().lower() in WEEKDAYS})
        start = parse_hhmm(r.start_time) if r else None
        if not r or not days or start is None:
            return [], None, f"Which days and what time does “{it.title}” repeat?"
        end = parse_hhmm(r.end_time) if r.end_time else None
        end = end or (datetime.combine(now.date(), start) + timedelta(minutes=DEFAULT_BLOCK_MINUTES)).time()
        first = parse_date(r.start_date, now.date()) if r.start_date else now.date()
        until = parse_date(r.until, now.date()) if r.until else None
        if first is None or (r.until and until is None):
            return [], None, f"From which day, and until when, does “{it.title}” repeat?"
        return [AddRecurring(id=new_id("rec"), title=it.title, weekdays=days, start=start, end=end, start_date=first, end_date=until)], None, None

    if it.bucket == "stop_recurring":
        match = next((x for x in ctx.recurring if x.id == it.target_id), None)
        if match is None:
            return [], None, "Which repeating commitment should stop?"
        frm = parse_date(it.stop_from, now.date()) if it.stop_from else now.date()
        return [StopRecurring(rule_id=match.id, from_date=frm or now.date(), title=match.title)], None, None

    if it.bucket == "source":
        if not source_id:
            return [], None, None
        gid = it.goal_id if it.goal_id in ctx.goal_ids else None
        return [LinkSource(source_id=source_id, goal_id=gid, title=it.title, summary=it.summary or "")], None, None

    if it.bucket == "todo" or (it.bucket == "task" and (it.goal_id not in ctx.goal_ids or not it.effort_hours)):
        # A small action, or "task" work the model could not tie to a goal and a size: file it as a
        # plain to-do rather than interrogating the user. It is sized and scheduled later if they want.
        gid = it.goal_id if it.goal_id in ctx.goal_ids else None
        return [AddTask(id=new_id("task"), goal_id=gid, title=it.title, effort_hours=it.effort_hours or None)], None, None

    if it.bucket == "task":
        task = AddTask(id=new_id("task"), goal_id=it.goal_id, title=it.title, effort_hours=it.effort_hours)
        blocks, how = place_task(chat, it.title, it.effort_hours, ctx, now, task_id=task.id)
        left_over = "no free room this week" if how == "no_room" else "couldn't find a good time yet"
        return [task, *blocks], (f"placed via {how}" if blocks else f"{left_over}; task added unscheduled"), None

    if it.bucket == "reminder":
        spec = it.reminder or ReminderSpec()
        start = parse_date(spec.date, now.date()) if spec.date else None
        start = start or now.date() + timedelta(days=1 if spec.start == "tomorrow" else 0)
        days, times = expand_reminder(spec.times_per_day, spec.duration_days, start)
        named = parse_hhmm(spec.at_time) if spec.at_time else None
        if named is not None:
            times = [named]
        gid = it.goal_id if it.goal_id in ctx.goal_ids else None
        return [AddReminder(id=new_id("rem"), title=it.title, days=days, times=times, goal_id=gid)], None, None

    # block
    b = it.block
    day = parse_date(b.date or b.day_ref or "", now.date()) if b else None
    if day is not None and day < now.date():
        return [], None, f"“{it.title}” is on a day that has already passed. Which day did you mean?"
    start = parse_hhmm(b.start_time) if b else None
    if day is None or start is None:
        return [], None, f"Which day and what time for “{it.title}”?"
    end = parse_hhmm(b.end_time) if b and b.end_time else None
    end = end or (datetime.combine(day, start) + timedelta(minutes=DEFAULT_BLOCK_MINUTES)).time()
    return [AddBlock(id=new_id("blk"), title=it.title, day=day, start=start, end=end, status=BLOCK_COMMITTED)], None, None


def route(chat, r: TriageResult, ctx: Context, now: datetime, origin: Origin, source_id: str | None = None) -> Routed:
    if r.question or r.confidence < TRIAGE_CONFIDENCE_MIN:
        return Routed(waiting=r.question or "Not sure what this is. Tap to sort it out.")

    changes: list[Change] = []
    notes: list[str] = []
    questions: list[str] = []
    running = ctx
    for it in r.items:
        new, note, question = _item(chat, it, running, now, source_id, from_image=bool(source_id))
        changes += new
        if note:
            notes.append(note)
        if question:
            questions.append(question)
        # Later items must see the blocks earlier items just placed, or two tasks could overlap.
        added = tuple(BlockRow(c.id, c.day, c.start, c.end, c.status, c.title) for c in new if isinstance(c, AddBlock))
        if added:
            running = replace(running, blocks=running.blocks + added)

    if not changes:
        if questions:
            return Routed(waiting=questions[0])
        return Routed(notes=[f"Kept as a note: {r.what_it_is}" if r.what_it_is else "Kept as a note"])
    if questions:
        notes.append("Still need your input: " + " ".join(questions))
    return Routed(ChangeSet(origin=origin, changes=changes), notes=notes)
