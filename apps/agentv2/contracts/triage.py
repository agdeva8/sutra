"""What the triage model fills. Lenient on purpose (`extra="ignore"`).

A real model volunteers keys nobody asked for, so rejecting the whole reply over
them would be a reliability bug. Note what is absent: no date and no time is
ever chosen here. `BlockSpec` carries the user's own words about when, and code
resolves them.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Llm(BaseModel):
    model_config = ConfigDict(extra="ignore")


Bucket = Literal["goal", "task", "reminder", "block", "recurring", "stop_recurring", "source", "done", "noise"]


class ReminderSpec(_Llm):
    times_per_day: int = Field(1, description="How many times a day, e.g. 3 for '3x daily'.")
    duration_days: int = Field(1, description="For how many days, e.g. 5 for 'x5 days'.")
    start: Literal["today", "tomorrow"] = "today"


class BlockSpec(_Llm):
    date: str | None = Field(None, description="The day as YYYY-MM-DD, read off the calendar you were given.")
    day_ref: str | None = Field(None, description="Only if you cannot give a date: the user's own words for the day.")
    start_time: str = Field(description="24h HH:MM copied from what the user said.")
    end_time: str | None = Field(None, description="24h HH:MM if the user gave an end, else null.")


class RecurringSpec(_Llm):
    weekdays: list[str] = Field(description="Weekday names the commitment falls on, e.g. ['tuesday', 'thursday'].")
    start_time: str = Field(description="24h HH:MM.")
    end_time: str | None = Field(None, description="24h HH:MM, or null if the user gave no end.")
    start_date: str | None = Field(None, description="YYYY-MM-DD it begins, if the user said; else null (it begins now).")
    until: str | None = Field(None, description="YYYY-MM-DD of the last day, if the user gave an end; else null (it repeats until stopped).")


class TriageItem(_Llm):
    """One thing found in a note or photo. A single entry can hold several."""

    bucket: Bucket
    title: str
    goal_id: str | None = Field(None, description="Must be one of the listed goal ids, or null.")
    effort_hours: float | None = Field(None, description="Rough hours of work, for a task.")
    reminder: ReminderSpec | None = None
    block: BlockSpec | None = None
    recurring: RecurringSpec | None = None
    stop_from: str | None = Field(None, description="For stop_recurring: YYYY-MM-DD it should stop from, if the user said; else null (from today).")
    target_id: str | None = Field(None, description="For done: the id of the listed open item the user finished. For stop_recurring: the id of the listed recurring commitment.")
    summary: str | None = Field(None, description="For a source: one or two sentences on what it contains and why it is worth keeping.")


class TriageResult(_Llm):
    #: What the note or photo is, in a few words, whatever it is ("meeting whiteboard").
    what_it_is: str = ""
    items: list[TriageItem] = Field(default_factory=list)
    confidence: float = Field(0.5, ge=0, le=1)
    question: str | None = Field(None, description="One question, only if you cannot tell what this is.")

    @property
    def bucket_label(self) -> str:
        """The distinct buckets found, for the card's kind label."""
        seen: list[str] = []
        for i in self.items:
            if i.bucket not in seen:
                seen.append(i.bucket)
        return "+".join(seen) or "noise"


class Placement(_Llm):
    window_id: str
    hours: float
    #: Minutes after the window opens, on the offered grid. 0 starts right at the window.
    start_offset_min: int = 0


class SlotPick(_Llm):
    placements: list[Placement]


class EntryChatReply(_Llm):
    reply: str = Field(description="What you say to the user: ONE short question, or a one-line confirmation when settled.")
    resolved: str | None = Field(None, description="Set once you know what the note means: a clear one or two sentence restatement of the note, using the user's answers. Leave empty while you still need to ask.")
