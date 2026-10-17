"""The four calendar block kinds (docs/calendar-block-kinds.md, "Target model").

Something is its own kind only if the planner handles it differently or the user
acts on it differently. Everything else — goal, time, repeat, alert — is a property.
"""
from __future__ import annotations

from datetime import date, time
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


BlockKind = Literal["event", "task", "away", "milestone"]


class Repeat(_Strict):
    """A weekly repeat: which weekdays and when it stops."""
    weekdays: list[int] = Field(min_length=1)  # Monday = 0
    until: date | None = None


class EventBlock(_Strict):
    """Time already taken (or marked on a day): a dinner, a meeting, a class every Tuesday.

    With no start/end: an all-day marker (birthday, holiday) that does not block capacity.
    With start/end: occupies the hour grid. Repeating events lay out occurrences 120 days ahead.
    """
    block_kind: Literal["event"] = "event"
    id: str | None = None  # Server assigns on create
    title: str
    day: date
    start: time | None = None
    end: time | None = None
    repeat: Repeat | None = None
    alert_before: int | None = Field(None, ge=0)  # minutes before; 0 = at time
    goal_id: str | None = None
    note: str = ""


class TaskBlock(_Strict):
    """Something the user does and ticks off: goal work, 'buy milk', 'call mom at 6'.

    - No day / no time: a list item (shown in Today's list).
    - A moment (at): a due-by time shown with the item ("call mom at 6", "by 5 PM").
    - start+end: a block on the hour grid. Always placed under a goal.
    """
    block_kind: Literal["task"] = "task"
    id: str | None = None  # Server assigns on create
    title: str
    day: date | None = None          # day it belongs to; None = undated list item
    start: time | None = None        # range start
    end: time | None = None          # range end
    at: time | None = None           # moment / due-by ("call at 6", "by 5 PM")
    effort_hours: float | None = Field(None, gt=0)
    goal_id: str | None = None
    milestone_id: str | None = None
    repeat: Repeat | None = None     # repeating task (e.g. "drink water 5x/day")
    #: A repeated small action ("send 5 applications" on each of `repeat.weekdays`): how many
    #: instances belong to one day. None for ordinary work. Optional so older rows stay valid.
    quota: int | None = Field(None, ge=1)
    #: For a quota, the instances already done per ISO day ({"2026-10-13": 3}).
    quota_done: dict[str, int] = Field(default_factory=dict)
    alert_before: int | None = Field(None, ge=0)
    done: bool = False
    state: Literal["open", "done", "partial", "skip"] = "open"
    done_fraction: float | None = Field(None, ge=0, le=1)
    description: str = ""
    why: str = ""
    placed_by: Literal["planner", "user"] = "user"


class AwayBlock(_Strict):
    """Whole days the user is out: a trip, leave, illness, holiday.

    Nothing is planned on those days. A one-day away is start_date == end_date.
    """
    block_kind: Literal["away"] = "away"
    id: str | None = None  # Server assigns on create
    title: str
    start_date: date
    end_date: date


class MilestoneBlock(_Strict):
    """A checkpoint on a goal, on a target date.

    The planner uses it as a planning horizon; the user marks it reached or not.
    """
    block_kind: Literal["milestone"] = "milestone"
    id: str | None = None  # Server assigns on create
    title: str
    goal_id: str
    target_date: date
    parent_id: str | None = None  # sub-step of a higher milestone
    hours: float = 0
    reached: bool = False


Block = Annotated[EventBlock | TaskBlock | AwayBlock | MilestoneBlock, Field(discriminator="block_kind")]

# P0 #5: Adapter to parse Block from union without calling model_validate on the union type.
from pydantic import TypeAdapter
BLOCK_ADAPTER = TypeAdapter(Block)


# ---------------------------------------------------------------------------
# Change types
# ---------------------------------------------------------------------------


class AddItem(_Strict):
    """Create one block of any kind."""
    kind: Literal["add_item"] = "add_item"
    block: Block


class EditItem(_Strict):
    """Replace a block's state (same kind). `before` is the previous full state for undo."""
    kind: Literal["edit_item"] = "edit_item"
    id: str
    block: Block
    before: dict = Field(default_factory=dict)


class DeleteItem(_Strict):
    """Remove a block. `block` holds the full state so undo can restore it."""
    kind: Literal["delete_item"] = "delete_item"
    id: str
    block: Block


class ItemResult(_Strict):
    """What a CRUD function returns."""
    id: str
    version: int
    block: Block
