"""One turn of goal intake: ask the next question, or commit to a draft.

Stateless on purpose: the caller keeps the `IntakeState` between turns (a DB row,
or round-tripped through the client), so agentv2 holds no session and nothing is
lost if the process restarts. After `MAX_INTAKE_TURNS` questions intake commits to
a best-effort draft instead of asking again.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from ..config import INTAKE_MAX_WEEKS, MAX_INTAKE_TURNS
from ..contracts import AddGoal, AddMilestone, Change
from ..contracts.intake import GoalDraft, IntakeReply, MilestoneDraft, IntakeState, Turn
from ..contracts.planner import GoalSpec, MilestoneSpec
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
    specs = [m.model_copy(update={"id": new_id("mile")}) for m in milestone_tree(draft.milestones, start, weeks)]
    ids = {m.title: m.id for m in specs}
    for m in specs:
        changes.append(AddMilestone(id=ids[m.title], goal_id=goal_id, title=m.title, target_date=m.due, parent_id=ids.get(m.parent), hours=m.hours))
    spec = GoalSpec(id=goal_id, title=draft.title, total_hours=max(draft.total_hours, 1.0), deadline=target, priority=priority, milestones=specs, weekly_hours=draft.weekly_hours or None)
    return spec, changes


def milestone_tree(drafts: list[MilestoneDraft], start: date, weeks: int) -> list[MilestoneSpec]:
    """The model's breakdown made valid: facets first, each followed by its sub-milestones.

    Week offsets become dates clamped to the goal's span. A sub-milestone naming a facet that does not
    exist becomes a facet itself, and a facet is due no earlier than its latest sub-milestone (the
    model may give several milestones the same week; that is allowed, not corrected)."""
    seen: dict[str, MilestoneDraft] = {}
    for d in drafts:
        if d.title.strip() and d.title not in seen:
            seen[d.title] = d
    parent_of = {t: (d.parent if d.parent in seen and d.parent != t and not seen[d.parent].parent else "") for t, d in seen.items()}
    week_of = {t: max(1, min(d.week, weeks)) for t, d in seen.items()}
    for t, p in parent_of.items():
        if p:
            week_of[p] = max(week_of[p], week_of[t])
    out: list[MilestoneSpec] = []
    for facet in sorted((t for t, p in parent_of.items() if not p), key=lambda t: week_of[t]):
        kids = sorted((t for t, p in parent_of.items() if p == facet), key=lambda t: week_of[t])
        hours = seen[facet].hours or sum(seen[k].hours for k in kids)
        out.append(MilestoneSpec(title=facet, due=start + timedelta(weeks=week_of[facet]), hours=max(hours, 0)))
        out += [MilestoneSpec(title=k, due=start + timedelta(weeks=week_of[k]), hours=max(seen[k].hours, 0), parent=facet) for k in kids]
    return out
