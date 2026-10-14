"""One turn of goal intake: ask the next question, or commit to a draft.

Stateless on purpose: the caller keeps the `IntakeState` between turns (a DB row,
or round-tripped through the client), so agentv2 holds no session and nothing is
lost if the process restarts. After `MAX_INTAKE_TURNS` questions intake commits to
a best-effort draft instead of asking again.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..config import INTAKE_MAX_WEEKS, MAX_INTAKE_TURNS
from ..contracts import AddGoal, AddMilestone, Change
from ..contracts.intake import GoalDraft, IntakeReply, IntakeState, Turn
from ..contracts.planner import GoalSpec
from ..core.ids import new_id
from ..llm import complete_json
from ..prompts.intake import INTAKE_SYSTEM, intake_user

MSG_UNREADABLE = "Couldn't think that through. Try again."


@dataclass
class IntakeStep:
    state: IntakeState
    #: Exactly one of question / draft is set, unless the model failed (then `error`).
    question: str | None = None
    options: list[str] = field(default_factory=list)
    draft: GoalDraft | None = None
    error: str | None = None


def intake_turn(chat, state: IntakeState | None, user_text: str, now: datetime) -> IntakeStep:
    state = (state or IntakeState()).model_copy(deep=True)
    state.turns.append(Turn(role="user", text=user_text))
    may_ask = state.questions_asked < MAX_INTAKE_TURNS

    reply = complete_json(chat, INTAKE_SYSTEM, intake_user([(t.role, t.text) for t in state.turns], now.date().isoformat(), may_ask), IntakeReply)
    if reply is None:
        return IntakeStep(state, error=MSG_UNREADABLE)

    if reply.draft is not None or not may_ask or not reply.question:
        if reply.draft is None:  # asked to stop but gave no draft: try once more, firmly
            reply = complete_json(chat, INTAKE_SYSTEM, intake_user([(t.role, t.text) for t in state.turns], now.date().isoformat(), False), IntakeReply)
        if reply is None or reply.draft is None:
            return IntakeStep(state, error=MSG_UNREADABLE)
        return IntakeStep(state, draft=reply.draft)

    state.turns.append(Turn(role="assistant", text=reply.question))
    state.questions_asked += 1
    return IntakeStep(state, question=reply.question, options=reply.options[:4])


def draft_to_changes(draft: GoalDraft, now: datetime, *, priority: int = 1) -> tuple[GoalSpec, list[Change]]:
    """Dates come from here, not from the model: week offsets become calendar dates."""
    weeks = max(1, min(draft.deadline_weeks, INTAKE_MAX_WEEKS))
    start = now.date()
    target = start + timedelta(weeks=weeks)
    goal_id = new_id("goal")
    changes: list[Change] = [AddGoal(id=goal_id, title=draft.title, why=draft.why, life_area=draft.life_area, start_date=start, target_date=target, total_hours=max(draft.total_hours, 1.0))]
    for m in sorted(draft.milestones, key=lambda m: m.week):
        when = start + timedelta(weeks=max(1, min(m.week, weeks)))
        changes.append(AddMilestone(id=new_id("mile"), goal_id=goal_id, title=m.title, target_date=when))
    spec = GoalSpec(id=goal_id, title=draft.title, total_hours=max(draft.total_hours, 1.0), deadline=target, priority=priority)
    return spec, changes
