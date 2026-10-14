"""Shapes shared by the validator and the gateway.

`Change` is a discriminated union on `kind`: each member has its own typed
payload, so a malformed change fails when it is built rather than deep inside
the gateway. These are constructed by our own code (`extra="forbid"`); the
LLM-facing shapes arrive in step 2 and use a lenient base instead.
"""
from __future__ import annotations

from datetime import date, time
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..config import BLOCK_TENTATIVE


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


BlockStatus = Literal["committed", "tentative"]


class AddGoal(_Strict):
    kind: Literal["add_goal"] = "add_goal"
    id: str
    title: str
    #: The user's own words on why, kept verbatim.
    why: str = ""
    life_area: str = ""
    start_date: date | None = None
    target_date: date | None = None
    #: Total effort the goal needs, so progress can be measured against it.
    total_hours: float | None = None


class AddMilestone(_Strict):
    """An outcome checkpoint on a goal. The date is code's, from the model's week offset."""

    kind: Literal["add_milestone"] = "add_milestone"
    id: str
    goal_id: str
    title: str
    target_date: date


class AddTask(_Strict):
    """Undated work under a goal. Placing it on a day is the planner's job."""

    kind: Literal["add_task"] = "add_task"
    id: str
    goal_id: str
    title: str
    effort_hours: float = Field(gt=0)


class AddReminder(_Strict):
    kind: Literal["add_reminder"] = "add_reminder"
    id: str
    title: str
    #: Times of day, repeated on each of `days`. Code expands this; the LLM never
    #: writes a datetime.
    days: list[date]
    times: list[time]
    goal_id: str | None = None


class AddBlock(_Strict):
    kind: Literal["add_block"] = "add_block"
    id: str
    title: str
    day: date
    start: time
    end: time
    status: BlockStatus = BLOCK_TENTATIVE
    #: Set for a block the agent placed for a task, so finishing the task can clear it.
    task_id: str | None = None
    goal_id: str | None = None


class AddPlanWeek(_Strict):
    """One week of a goal's plan: a focus and the hours set aside, no particular day."""

    kind: Literal["add_plan_week"] = "add_plan_week"
    id: str
    goal_id: str
    week_start: date
    focus: str
    hours: float = Field(gt=0)


class CompleteItem(_Strict):
    """The user says something is finished. Reversible, so it applies without asking."""

    kind: Literal["complete_item"] = "complete_item"
    item_id: str
    title: str = ""


class AddRecurring(_Strict):
    """A fixed commitment that repeats on some weekdays (Monday = 0) until it is stopped or reaches its end date."""

    kind: Literal["add_recurring"] = "add_recurring"
    id: str
    title: str
    weekdays: list[int] = Field(min_length=1)
    start: time
    end: time
    start_date: date
    end_date: date | None = None


class StopRecurring(_Strict):
    """End a recurring commitment: nothing from `from_date` on is kept."""

    kind: Literal["stop_recurring"] = "stop_recurring"
    rule_id: str
    from_date: date
    title: str = ""


class ClearGoalPlan(_Strict):
    """Remove a goal's open plan from `from_date` on, so it can be planned again. Only the agent's
    own planned (tentative) blocks and unfinished weekly rows go; fixed blocks and finished work stay."""

    kind: Literal["clear_goal_plan"] = "clear_goal_plan"
    goal_id: str
    from_date: date


class LinkSource(_Strict):
    """Keep an uploaded photo or file and file it under a goal (or none).

    The bytes already exist as a source; this records what the agent made of it.
    """

    kind: Literal["link_source"] = "link_source"
    source_id: str
    goal_id: str | None = None
    title: str
    summary: str


class MoveBlock(_Strict):
    kind: Literal["move_block"] = "move_block"
    block_id: str
    day: date
    start: time
    end: time


Change = Annotated[
    AddRecurring | StopRecurring | ClearGoalPlan | CompleteItem | AddGoal | AddMilestone | AddTask | AddReminder | AddBlock | MoveBlock | LinkSource | AddPlanWeek,
    Field(discriminator="kind"),
]


class Origin(_Strict):
    """Where a change set came from, for the audit row's provenance."""

    source: Literal["scratch", "goal", "tick", "manual", "chat"]
    ref: str | None = None


class ChangeSet(_Strict):
    changes: list[Change]
    origin: Origin
