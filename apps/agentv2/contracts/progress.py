"""What the progress judge returns. Lenient (`extra="ignore"`): the model fills it.

The numbers are code's (`progress.facts`); the model only says what they mean. A level or milestone it
leaves out simply has no verdict, and the UI shows its numbers without one.
"""
from __future__ import annotations

from typing import Literal

from pydantic import Field

from .triage import _Llm

Status = Literal["not_started", "ahead", "on_track", "drifting", "behind"]


class LevelVerdict(_Llm):
    id: str = Field(description="The id of the month or week being judged, copied from the facts.")
    status: Status
    note: str = Field("", description="One short sentence, honest about the numbers, to the person ('you').")


class MilestoneVerdict(_Llm):
    id: str = Field(description="The id of the milestone, copied from the facts.")
    status: Status
    note: str = ""


class GoalVerdict(_Llm):
    status: Status
    note: str = Field("", description="Two sentences at most on where the goal stands against its deadline, to the person ('you').")
    levels: list[LevelVerdict] = Field(default_factory=list)
    milestones: list[MilestoneVerdict] = Field(default_factory=list)
