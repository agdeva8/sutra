"""The context a refining turn gets: the plan it is revising stays in view.

Two failures this pins down. The model used to see only its own prose — the target date, the hours
and the milestones it had proposed were dropped from history, so a refinement invented a new plan.
And the window was 12 turns, so the turn that proposed the plan being edited could already be gone.
"""
from dataclasses import dataclass, field

from sutra_api.api.chat import (
    CHAT_CONTEXT_TURNS,
    CONTEXT_TURNS_SCOPED,
    _history_with_summaries,
    _proposals_summary,
)


@dataclass
class Row:
    id: str
    role: str
    content: str
    questions: list = field(default_factory=list)


@dataclass
class Proposal:
    action: str
    args: dict


def test_a_scoped_conversation_keeps_the_whole_add_goal_exchange():
    # The turn that proposed the plan can be dozens of messages back in a long intake conversation.
    assert CONTEXT_TURNS_SCOPED == 60
    assert CHAT_CONTEXT_TURNS == 60


def test_the_goal_every_assistant_turn_keeps_what_it_proposed():
    summary = _proposals_summary([
        Proposal("create_goal", {"title": "Switch jobs", "target_date": "2027-01-15", "weekly_hours": 6}),
        Proposal("add_milestone", {"title": "Resume fixed", "target_date": "2026-11-01"}),
        Proposal("add_milestone", {"title": "Ten applications sent", "target_date": "2026-12-01"}),
    ])
    assert "Proposed: goal 'Switch jobs', by 2027-01-15, 6h/week" in summary
    assert "milestones: Resume fixed (2026-11-01), Ten applications sent (2026-12-01)" in summary


def test_an_edit_proposal_is_described_as_an_update():
    summary = _proposals_summary([
        Proposal("update_goal", {"title": "Switch jobs", "target_date": "2027-03-01", "weekly_hours": 8}),
    ])
    assert "goal 'Switch jobs' updated, by 2027-03-01, 8h/week" in summary


def test_the_summary_bounds_a_very_long_milestone_set():
    proposals = [Proposal("add_milestone", {"title": f"M{i}", "target_date": f"2027-01-{i:02d}"}) for i in range(1, 21)]
    summary = _proposals_summary(proposals)
    assert "+8 more" in summary


def test_a_turn_without_proposals_adds_nothing():
    assert _proposals_summary([]) == ""
    assert _proposals_summary([Proposal("ask", {"questions": ["When?"]})]) == ""


def test_history_carries_each_turns_proposal_summary():
    rows = [
        Row("m1", "user", "I want to switch jobs in 3 months"),
        Row("m2", "assistant", "Here is a plan."),
        Row("m3", "user", "Make the resume step earlier"),
    ]
    by_message = {
        "m2": [
            Proposal("create_goal", {"title": "Switch jobs", "target_date": "2027-01-15", "weekly_hours": 6}),
            Proposal("add_milestone", {"title": "Resume fixed", "target_date": "2026-11-01"}),
        ]
    }
    history = _history_with_summaries(rows, by_message)
    assistant = next(turn for turn in history if turn["role"] == "assistant")
    assert assistant["content"].startswith("Here is a plan.")
    assert "Proposed: goal 'Switch jobs', by 2027-01-15, 6h/week" in assistant["content"]
    assert "Resume fixed (2026-11-01)" in assistant["content"]
    # Turns without proposals are unchanged.
    assert history[0]["content"] == "I want to switch jobs in 3 months"
