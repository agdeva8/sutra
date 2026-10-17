"""Planner shapes. `GoalSpec` is built by code (intake, step 4); the plans are filled by the model."""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .triage import _Llm

#: The three kinds of day-level item. A `focus` item is a timed sitting; `quota` is a repeated
#: small action ("5 applications", Mon–Fri); `multi_day` is one piece of work spread over days.
DayItemKind = Literal["focus", "quota", "multi_day"]
DAY_ITEM_FOCUS: DayItemKind = "focus"


class MilestoneSpec(BaseModel):
    """A milestone as the planner sees it: what the week and day sessions are built from."""

    model_config = ConfigDict(extra="forbid")

    title: str
    due: date
    hours: float = 0
    #: The milestone row's id, so a task can point at the milestone it serves; empty before it is written.
    id: str = ""
    #: Title of the facet it belongs to; empty for a facet.
    parent: str = ""


class GoalSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    #: Total effort the goal needs between now and its deadline.
    total_hours: float = Field(gt=0)
    deadline: date | None = None
    #: Lower runs first when goals compete for the same time.
    priority: int = 1
    #: The pace the user asked for on this goal; no week is planned above it. None when they gave none.
    weekly_hours: float | None = None
    #: The goal's breakdown, facets and their sub-milestones. Empty for a goal planned without one.
    milestones: list[MilestoneSpec] = Field(default_factory=list)


class WeekItem(_Llm):
    week_id: str
    focus: str = Field(description="What to concentrate on that week, a short phrase.")
    milestones: list[str] = Field(default_factory=list, description="Titles of the milestones this week's work moves forward, copied exactly; usually several, from different facets.")
    hours: float
    why: str = Field("", description="One plain sentence to the user on why this is here: how it serves the goal, the deadline or the calendar. Not a restatement of the title.")
    #: Two to four things the user can check off by the end of the week ("20 applications sent").
    #: Optional: an older reply without them is still a usable plan.
    outcomes: list[str] = Field(default_factory=list, description="2-4 outcomes the user can check off by the end of the week, each a short countable result.")


class WeekPlan(_Llm):
    weeks: list[WeekItem]


class DayItem(_Llm):
    day_id: str
    title: str = Field(description="The item, a short phrase.")
    milestone: str = Field("", description="Title of the milestone this work serves, copied exactly from the week's list.")
    #: `focus`: the hours of one timed sitting. `quota`: the week's total effort for the quota
    #: (count × minutes_each × weekdays / 60); code derives the per-day effort itself. `multi_day`:
    #: the total effort spread over `days`.
    hours: float
    #: One line on what this work actually involves, so the task can explain itself. Optional: an
    #: older reply without it is still a usable plan.
    description: str = ""
    why: str = Field("", description="One plain sentence to the user on why this is here: how it serves the goal, the deadline or the calendar. Not a restatement of the title.")
    #: What shape the work takes. Defaults to `focus`, so a reply written before the kinds existed
    #: still parses as the timed sessions it was always meant to be.
    kind: DayItemKind = DAY_ITEM_FOCUS
    # --- quota ("Send 5 applications every weekday, 30 min each") ---
    #: How many times the action is done on each of `weekdays`, in a day.
    count: int = 0
    #: Minutes one instance of the action takes.
    minutes_each: int = 0
    #: Weekdays the quota falls on, Monday = 0, within the week.
    weekdays: list[int] = Field(default_factory=list)
    # --- multi_day ("System design: caching", Tue–Wed) ---
    #: Day ids the item spans, within the week (`days` of a multi-day item).
    days: list[str] = Field(default_factory=list)


class DayPlan(_Llm):
    sessions: list[DayItem]


class MonthItem(_Llm):
    month_id: str
    focus: str = Field("", description="What the month is for, a short phrase: the outcome its weeks add up to.")
    hours: float
    why: str = Field("", description="One plain sentence to the user on why this is here: how it serves the goal, the deadline or the calendar. Not a restatement of the title.")
    #: Two to four things the user can check off by the end of the month. Optional, like a week's.
    outcomes: list[str] = Field(default_factory=list, description="2-4 outcomes the user can check off by the end of the month, each a short countable result.")


class MonthPlan(_Llm):
    months: list[MonthItem]


class Critique(_Llm):
    ok: bool
    problems: list[str] = Field(default_factory=list, description="Each problem in one sentence, specific enough to fix.")


class SessionPlacement(_Llm):
    session_id: str
    window_id: str
    start_offset_min: int = 0
    why: str = Field("", description="One plain sentence on why this time suits the session: what is around it, the user's energy, the gap it leaves.")


class SessionPlan(_Llm):
    placements: list[SessionPlacement]
