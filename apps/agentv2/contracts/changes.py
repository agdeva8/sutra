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

from ..config import BLOCK_TENTATIVE, TODO_PRIORITY_NORMAL
from .blocks import AddItem, EditItem, DeleteItem, TodoPriority


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
    #: The facet milestone this one is a step of; `None` for a facet (a top-level milestone).
    parent_id: str | None = None
    #: Effort the milestone needs on its own; 0 when unknown (milestones added by hand).
    hours: float = 0


class MilestoneInput(_Strict):
    """One milestone in a replacement set. `AddMilestone` minus the goal id, which the set carries."""

    id: str
    title: str
    #: `None` only when the goal itself has no deadline; otherwise the builder dates every milestone.
    target_date: date | None = None
    parent_id: str | None = None
    hours: float = 0


class ReplaceMilestones(_Strict):
    """Replace a goal's **open** milestones with this set, keeping the ones already done.

    Editing a goal re-proposes the whole plan; confirming applies the goal update and this set as one
    change, so a refinement can add, drop, re-date and re-size milestones in one transaction. Done
    milestones are never touched — they record work already achieved, and re-dating one would rewrite
    history. The store keeps them regardless of whether they are listed here, and removes every open
    milestone of the goal that this set leaves out.
    """

    kind: Literal["replace_milestones"] = "replace_milestones"
    goal_id: str
    milestones: list[MilestoneInput] = Field(default_factory=list)
    #: The open milestones this set replaces, as they were. The builder fills it from the store so
    #: undo can put them back; the validator ignores it and the writer never reads it.
    before: list[MilestoneInput] = Field(default_factory=list)


class AddTask(_Strict):
    """Work under a goal, and the day it is for when the planner has picked one.

    `day` is what makes a task visible on a calendar: without it the row has no date, so the week and
    day views have nowhere to put it. The planner always knows the day it chose, so it passes it; a
    task with no day is the honest case of work that would not fit any day.
    """

    kind: Literal["add_task"] = "add_task"
    id: str
    #: `None` for a plain to-do that belongs to no goal.
    goal_id: str | None = None
    title: str
    #: `None` for a to-do the user never sized; the planner always sets it.
    effort_hours: float | None = Field(None, gt=0)
    #: The day this session is for. `None` when the day could not hold it.
    day: date | None = None
    #: The time of day a dated to-do is due by ("by 5 PM"); shown with the task, never a scheduled block.
    due_time: time | None = None
    #: One line on what the session actually involves, for the task's own detail view.
    description: str = ""
    #: Why this exists, one plain sentence for the user, shown when they open it.
    why: str = ""
    #: The milestone this session works toward, when the goal has a breakdown.
    milestone_id: str | None = None


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
    #: Why this exists, one plain sentence for the user, shown when they open it.
    why: str = ""


class AddBlocker(_Strict):
    """The user is unavailable for whole days (a trip, leave, an illness): one date range, not a block per day.
    No goal work is planned on these days, and planned time already on them gives way."""

    kind: Literal["add_blocker"] = "add_blocker"
    id: str
    title: str
    start_date: date
    end_date: date


class AddPlanWeek(_Strict):
    """One week of a goal's plan: a focus and the hours set aside, no particular day."""

    kind: Literal["add_plan_week"] = "add_plan_week"
    id: str
    goal_id: str
    week_start: date
    focus: str
    hours: float = Field(gt=0)
    #: Why this exists, one plain sentence for the user, shown when they open it.
    why: str = ""
    #: What the user can check off by the end of the week, 2-4 short results. Stored one per line in
    #: the plan row's `description` column; optional so an older plan still writes.
    outcomes: list[str] = Field(default_factory=list)


class AddPlanMonth(_Strict):
    """One month of a goal's plan: what the month is for and the hours set aside. The weeks inside it
    are what achieves it; a month with no weeks of work is simply a month with no row."""

    kind: Literal["add_plan_month"] = "add_plan_month"
    id: str
    goal_id: str
    #: The first day of the month.
    month_start: date
    focus: str
    hours: float = Field(gt=0)
    #: Why this exists, one plain sentence for the user, shown when they open it.
    why: str = ""
    #: What the user can check off by the end of the month; stored like a week's outcomes.
    outcomes: list[str] = Field(default_factory=list)


class CompleteItem(_Strict):
    """The user says something is finished. Reversible, so it applies without asking."""

    kind: Literal["complete_item"] = "complete_item"
    item_id: str
    title: str = ""
    #: A tick: all of it, part of it (`fraction` of the work), or it was not done at all and is let go.
    outcome: Literal["full", "partial", "skip"] = "full"
    #: For "partial": the share of the work that got done, between 0 and 1 (exclusive).
    fraction: float | None = Field(None, gt=0, lt=1)


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


#: Fields of a to-do an edit may set back to empty.
TodoClearable = Literal["day", "due_time", "description", "goal_id"]


class AddTodo(_Strict):
    """Something the user means to do, owned by nobody's plan: no hours, no scheduling, just a list.

    Distinct from `AddTask` (a goal's sized session the planner places) so every read can tell the two
    apart: a to-do has a priority and the user's own description, and never gets goal-task actions.
    """

    kind: Literal["add_todo"] = "add_todo"
    id: str
    title: str
    #: Optional: a to-do may be "for" a goal without being part of its plan.
    goal_id: str | None = None
    #: The day it is for; `None` keeps it on Today until it is done.
    day: date | None = None
    #: The time of day it is due by, on `day`.
    due_time: time | None = None
    priority: TodoPriority = TODO_PRIORITY_NORMAL
    description: str = ""


class EditTodo(_Strict):
    """Change a to-do's fields, or tick / un-tick it. Only the fields given (not None) change; `clear`
    empties optional ones. `before` holds the previous values so undo can put them back."""

    kind: Literal["edit_todo"] = "edit_todo"
    id: str
    title: str | None = None
    goal_id: str | None = None
    day: date | None = None
    due_time: time | None = None
    priority: TodoPriority | None = None
    description: str | None = None
    done: bool | None = None
    clear: list[TodoClearable] = Field(default_factory=list)
    before: dict = Field(default_factory=dict)


class MoveBlock(_Strict):
    kind: Literal["move_block"] = "move_block"
    block_id: str
    day: date
    start: time
    end: time


Change = Annotated[
    AddBlocker | AddRecurring | StopRecurring | ClearGoalPlan | CompleteItem | AddGoal | AddMilestone | ReplaceMilestones | AddTask | AddReminder | AddBlock | MoveBlock | LinkSource | AddPlanWeek | AddPlanMonth | AddTodo | EditTodo
    | AddItem | EditItem | DeleteItem,
    Field(discriminator="kind"),
]


class Origin(_Strict):
    """Where a change set came from, for the audit row's provenance."""

    source: Literal["scratch", "goal", "tick", "manual", "chat"]
    ref: str | None = None


class ChangeSet(_Strict):
    changes: list[Change]
    origin: Origin
