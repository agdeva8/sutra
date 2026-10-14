"""A coach-chat turn. The model fills `ChatPlanReply`; the API gets a `ChatTurn` back."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import Field

from .triage import _Llm


class ProposalSpec(_Llm):
    action: str
    args: dict[str, Any] = Field(default_factory=dict)


class ChatPlanReply(_Llm):
    #: capture: the message contains things to file (a task, a reminder, a busy time, "done X").
    #: change: the user wants their goals or availability changed (edit, pause, drop, dates, away).
    #: ask: a question or conversation the normal chat should answer.
    intent: Literal["capture", "change", "ask"] = "ask"
    prose: str = Field("", description="A short reply to the user. For a change, say what you propose.")
    question: str | None = Field(None, description="ONE question, only if you cannot tell what they want changed.")
    proposals: list[ProposalSpec] = Field(default_factory=list)


@dataclass
class ChatTurn:
    #: "ok" (something was filed or proposed), "clarify" (a question for the user), "not_planned"
    #: (let the ordinary chat answer).
    kind: str
    prose: str = ""
    questions: list[str] = field(default_factory=list)
    #: Proposals the user must confirm, in the confirm flow's action vocabulary.
    proposals: list[dict] = field(default_factory=list)
    #: What was filed without asking (one line each), when the turn captured something.
    applied: list[str] = field(default_factory=list)
