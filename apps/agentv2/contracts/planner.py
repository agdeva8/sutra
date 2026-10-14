"""Planner shapes. `GoalSpec` is built by code (intake, step 4); the plans are filled by the model."""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict, Field

from .triage import _Llm


class GoalSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    #: Total effort the goal needs between now and its deadline.
    total_hours: float = Field(gt=0)
    deadline: date | None = None
    #: Lower runs first when goals compete for the same time.
    priority: int = 1


class WeekItem(_Llm):
    week_id: str
    focus: str = Field(description="What to concentrate on that week, a short phrase.")
    hours: float


class WeekPlan(_Llm):
    weeks: list[WeekItem]


class DayItem(_Llm):
    day_id: str
    title: str = Field(description="The session, a short phrase.")
    hours: float


class DayPlan(_Llm):
    sessions: list[DayItem]


class MonthItem(_Llm):
    month_id: str
    hours: float


class MonthPlan(_Llm):
    months: list[MonthItem]


class Critique(_Llm):
    ok: bool
    problems: list[str] = Field(default_factory=list, description="Each problem in one sentence, specific enough to fix.")


class SessionPlacement(_Llm):
    session_id: str
    window_id: str
    start_offset_min: int = 0


class SessionPlan(_Llm):
    placements: list[SessionPlacement]
