"""From a `TriageResult` to a `ChangeSet` the gateway can take, or to "ask the user".

One entry can hold several items (a photo of a prescription lists two medicines;
a whiteboard is a source plus some actions). Each item becomes its own change;
the items that cannot be filed yet contribute a question instead. Every date comes
from code (`core.dates`, `core.recur`, `core.slots`); the model's output is only meaning.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta

from ..config import BLOCK_COMMITTED, DEFAULT_BLOCK_MINUTES, FOUR_KIND_WRITES, MAX_AWAY_DAYS, TRIAGE_CONFIDENCE_MIN
from ..config import TODO_ID_PREFIX
from ..contracts import AddBlocker, AddRecurring, StopRecurring, CompleteItem, AddBlock, AddGoal, AddReminder, AddTask, AddTodo, Change, ChangeSet, LinkSource, Origin
from ..contracts.blocks import AddItem, AwayBlock, EditItem, EventBlock, MilestoneBlock, Repeat, TaskBlock
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
            return [], None, f"Which one did you finish? I couldn't match \"{it.title}\"."
        outcome = it.outcome if it.outcome != "partial" or (it.fraction and 0 < it.fraction < 1) else "full"
        frac = it.fraction if outcome == "partial" else None
        return [CompleteItem(item_id=it.target_id, title=ctx.open_items[it.target_id], outcome=outcome, fraction=frac)], None, None

    if it.bucket == "away":
        a = it.away
        first = parse_date(a.start_date, now.date()) if a else None
        last = (parse_date(a.end_date, now.date()) if a.end_date else first) if a else None
        if first is None or last is None or last < first:
            return [], None, f"Which days are you away for \"{it.title}\"?"
        if last < now.date():
            return [], None, f"\"{it.title}\" is on days that have already passed. Which days did you mean?"
        if (last - first).days >= MAX_AWAY_DAYS:
            return [], None, f"That is more than {MAX_AWAY_DAYS} days. When exactly are you away for \"{it.title}\"?"
        if FOUR_KIND_WRITES:
            return [AddItem(block=AwayBlock(id=new_id("away"), title=it.title, start_date=first, end_date=last))], None, None
        return [AddBlocker(id=new_id("away"), title=it.title, start_date=first, end_date=last)], None, None

    if it.bucket == "recurring":
        r = it.recurring
        days = sorted({WEEKDAYS.index(w.strip().lower()) for w in (r.weekdays if r else []) if w.strip().lower() in WEEKDAYS})
        start = parse_hhmm(r.start_time) if r else None
        if not r or not days or start is None:
            return [], None, f"Which days and what time does \"{it.title}\" repeat?"
        end = parse_hhmm(r.end_time) if r.end_time else None
        end = end or (datetime.combine(now.date(), start) + timedelta(minutes=DEFAULT_BLOCK_MINUTES)).time()
        first = parse_date(r.start_date, now.date()) if r.start_date else now.date()
        until = parse_date(r.until, now.date()) if r.until else None
        if first is None or (r.until and until is None):
            return [], None, f"From which day, and until when, does \"{it.title}\" repeat?"
        if FOUR_KIND_WRITES:
            repeat = Repeat(weekdays=days, until=until)
            return [AddItem(block=EventBlock(
                id=new_id("evt"), title=it.title, day=first, start=start, end=end, repeat=repeat
            ))], None, None
        return [AddRecurring(id=new_id("rec"), title=it.title, weekdays=days, start=start, end=end, start_date=first, end_date=until)], None, None

    if it.bucket == "stop_recurring":
        match = next((x for x in ctx.recurring if x.id == it.target_id), None)
        if match is None:
            return [], None, "Which repeating commitment should stop?"
        frm = parse_date(it.stop_from, now.date()) if it.stop_from else now.date()
        stop_date = frm or now.date()
        if FOUR_KIND_WRITES:
            # Emit EditItem for the repeating Event, setting repeat.until to the day before stop_date
            # The gateway fills 'before' from context
            evt = ctx.items.get(match.id) if match else None
            if evt and evt.block_kind == "event":
                # Create a copy with updated repeat.until
                new_repeat = Repeat(weekdays=evt.repeat.weekdays, until=stop_date - timedelta(days=1)) if evt.repeat else Repeat(weekdays=[], until=stop_date - timedelta(days=1))
                new_evt = evt.model_copy(update={"repeat": new_repeat})
                return [EditItem(id=match.id, block=new_evt)], None, None
            # If not in ctx.items, fall back to old behavior
            return [StopRecurring(rule_id=match.id, from_date=stop_date, title=match.title)], None, None
        return [StopRecurring(rule_id=match.id, from_date=stop_date, title=match.title)], None, None

    if it.bucket == "source":
        if not source_id:
            return [], None, None
        gid = it.goal_id if it.goal_id in ctx.goal_ids else None
        return [LinkSource(source_id=source_id, goal_id=gid, title=it.title, summary=it.summary or "")], None, None

    if it.bucket == "todo" or (it.bucket == "task" and (it.goal_id not in ctx.goal_ids or not it.effort_hours)):
        # A small action, or "task" work the model could not tie to a goal and a size: file it as a
        # plain to-do rather than interrogating the user. It is sized and scheduled later if they want.
        gid = it.goal_id if it.goal_id in ctx.goal_ids else None
        due_day = parse_date(it.due.date, now.date()) if it.due and it.due.date else None
        due_time = parse_hhmm(it.due.time) if it.due and it.due.time else None
        if due_day is not None and due_day < now.date():
            due_day = None  # a due date already gone is a misread; file it undated rather than in the past
        if FOUR_KIND_WRITES:
            return [AddItem(block=TaskBlock(
                id=new_id(TODO_ID_PREFIX), title=it.title, goal_id=gid,
                day=due_day, at=due_time if due_day else None, placed_by="user"
            ))], None, None
        return [AddTodo(id=new_id(TODO_ID_PREFIX), goal_id=gid, title=it.title,
                        day=due_day, due_time=due_time if due_day else None)], None, None

    if it.bucket == "task":
        task = AddTask(id=new_id("task"), goal_id=it.goal_id, title=it.title, effort_hours=it.effort_hours)
        blocks, how = place_task(chat, it.title, it.effort_hours, ctx, now, task_id=task.id, goal_id=task.goal_id)
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
        if FOUR_KIND_WRITES:
            # One Task per time of day (D8), with at=time, alert_before=0
            changes = []
            for t in times:
                changes.append(AddItem(block=TaskBlock(
                    id=new_id("rem"), title=it.title, goal_id=gid,
                    at=t, alert_before=0, placed_by="user"
                )))
            return changes, None, None
        return [AddReminder(id=new_id("rem"), title=it.title, days=days, times=times, goal_id=gid)], None, None

    # block
    b = it.block
    day = parse_date(b.date or b.day_ref or "", now.date()) if b else None
    if day is not None and day < now.date():
        return [], None, f"\"{it.title}\" is on a day that has already passed. Which day did you mean?"
    start = parse_hhmm(b.start_time) if b else None
    if day is None or start is None:
        return [], None, f"Which day and what time for \"{it.title}\"?"
    end = parse_hhmm(b.end_time) if b and b.end_time else None
    end = end or (datetime.combine(day, start) + timedelta(minutes=DEFAULT_BLOCK_MINUTES)).time()
    # A time the user named stays committed (the planner must not move it); a goal on it is colour and progress, not a licence to move.
    gid = it.goal_id if it.goal_id in ctx.goal_ids else None
    if FOUR_KIND_WRITES:
        # D9: A block with a goal -> Task(placed_by=user). A block without a goal -> Event.
        if gid:
            return [AddItem(block=TaskBlock(
                id=new_id("task"), title=it.title, day=day, start=start, end=end,
                goal_id=gid, placed_by="user"
            ))], None, None
        return [AddItem(block=EventBlock(
            id=new_id("evt"), title=it.title, day=day, start=start, end=end
        ))], None, None
    return [AddBlock(id=new_id("blk"), title=it.title, day=day, start=start, end=end, status=BLOCK_COMMITTED, goal_id=gid)], None, None


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
        # For new 4-kind path, also add to ctx.items so later AddItem checks see them
        added = []
        for c in new:
            if isinstance(c, AddBlock):
                added.append(BlockRow(c.id, c.day, c.start, c.end, c.status, c.title))
            elif isinstance(c, AddItem):
                blk = c.block
                if blk.block_kind == "event" and blk.start and blk.end:
                    added.append(BlockRow(blk.id, blk.day, blk.start, blk.end, BLOCK_COMMITTED, blk.title, goal_id=blk.goal_id))
                elif blk.block_kind == "task" and blk.start and blk.end and blk.placed_by == "planner":
                    added.append(BlockRow(blk.id, blk.day, blk.start, blk.end, BLOCK_COMMITTED, blk.title, goal_id=blk.goal_id))
                # Add to ctx.items so later edits see them
                running = replace(running, items={**running.items, blk.id: blk})
        if added:
            running = replace(running, blocks=running.blocks + tuple(added))

    if not changes:
        if questions:
            return Routed(waiting=questions[0])
        return Routed(notes=[f"Kept as a note: {r.what_it_is}" if r.what_it_is else "Kept as a note"])
    if questions:
        notes.append("Still need your input: " + " ".join(questions))
    return Routed(ChangeSet(origin=origin, changes=changes), notes=notes)
