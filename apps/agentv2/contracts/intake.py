"""Goal intake shapes. The model fills `IntakeReply`; `IntakeState` is what the caller round-trips."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from .triage import _Llm


class MilestoneDraft(_Llm):
    """One node of the goal's breakdown. Flat on the wire (a `parent` title, not nesting), so the schema
    the model reads stays simple; `draft_to_changes` rebuilds the tree."""

    title: str
    parent: str = Field("", description="The exact title of the facet this sub-milestone belongs to; empty for a facet itself.")
    hours: float = Field(0, description="Effort this milestone needs on its own, in hours.")
    week: int = Field(description="Weeks from today when this should be reached. Attached after the breakdown; milestones may share a week.")


class GoalDraft(_Llm):
    title: str
    #: The user's own words on why they want it, verbatim where they gave them.
    why: str = ""
    life_area: str = ""
    total_hours: float = Field(description="Total effort the goal needs, in hours.")
    deadline_weeks: int = Field(description="Weeks from today until the goal should be done.")
    weekly_hours: float | None = Field(None, description="Hours a week the user said they can give this goal, if they said.")
    milestones: list[MilestoneDraft] = Field(default_factory=list)


class IntakeReply(_Llm):
    question: str | None = Field(None, description="The ONE next question, if something that changes the plan is still unknown.")
    options: list[str] = Field(default_factory=list, description="Two to four short answers to offer, if the question has natural ones.")
    draft: GoalDraft | None = Field(None, description="Set when you have enough to plan. Leave question empty then.")


class Turn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: str  # "user" | "assistant"
    text: str


class IntakeState(BaseModel):
    """The conversation so far. Opaque to the caller: store it or echo it back, never edit it."""

    model_config = ConfigDict(extra="forbid")
    turns: list[Turn] = Field(default_factory=list)
    questions_asked: int = 0
