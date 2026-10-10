"""The LLM boundary — tolerant of invention, intolerant of dates.

Every payload in here is one a real model actually returned, not one invented to
make a point. The first block is the verbatim shape DeepSeek produced on the
first real run: `material_unknowns` as `{key, reason}` dicts, no `id` on the
questions, and six extra top-level fields. That response failed validation with
23 errors and the agent could not plan at all.

The contract's job is to be the *edge*, so it absorbs that. The one thing it
still refuses is a date on a task — the guarantee the whole design rests on.
"""
from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from app.contracts import schemas as S
from app.llm.client import _parse, schema_brief

#: Verbatim from the first DeepSeek run that failed with 23 validation errors.
DEEPSEEK_INTAKE = {
    "intent": "add_goal",
    "material_unknowns": [
        {"key": "target_role_domain", "reason": "the user did not name a field"},
        {"key": "hours_per_week", "reason": "no availability was stated"},
        {"key": "deadline", "reason": "no target date was given"},
    ],
    "clarifying_questions": [
        {
            "question": "Which role or domain are you targeting?",
            "options": [{"label": "software engineering"}, {"label": "data / ML"}],
            "addresses": "target_role_domain",
            "format": "single_choice",
            "hint": "pick the closest",
            "note": "this changes the whole plan",
        }
    ],
    "referenced_goal_titles": [],
    "framing_line": "Planning a job change.",
    "confidence": 0.82,
    "can_plan": False,
    "reason": "a material unknown blocks planning",
    "known": {"role": None},
    "next_action": "ask_clarifying_questions",
    "plan_emitted": False,
}


# --------------------------------------------------------------------------
# the real payload
# --------------------------------------------------------------------------


def test_the_real_deepseek_intake_payload_now_validates():
    spec = S.IntakeSpec.model_validate(DEEPSEEK_INTAKE)
    assert spec.intent == "add_goal"
    # dicts normalised to names, not left as dicts
    assert spec.material_unknowns == [
        "target_role_domain",
        "hours_per_week",
        "deadline",
    ]
    assert len(spec.clarifying_questions) == 1
    assert spec.clarifying_questions[0].options == ["software engineering", "data / ML"]


def test_a_missing_question_id_is_generated_not_rejected():
    spec = S.IntakeSpec.model_validate(DEEPSEEK_INTAKE)
    q = spec.clarifying_questions[0]
    assert q.id, "the graph needs a key to hang the answer on"
    # and it is stable for the same question
    again = S.IntakeSpec.model_validate(DEEPSEEK_INTAKE)
    assert again.clarifying_questions[0].id == q.id


def test_unrequested_extra_fields_are_ignored_not_fatal():
    """`confidence`, `can_plan`, `next_action` … none of them are our contract."""
    spec = S.IntakeSpec.model_validate(DEEPSEEK_INTAKE)
    assert not hasattr(spec, "confidence")


def test_a_material_unknown_still_forces_a_question():
    """The §10 invariant survives the relaxation — it just completes rather than
    rejects when the model lists an unknown and forgets to ask about it."""
    spec = S.IntakeSpec.model_validate(
        {"intent": "add_goal", "material_unknowns": ["hours available per week"]}
    )
    assert spec.clarifying_questions, "an unknown with no question must still ask"
    assert "hours available per week" in spec.clarifying_questions[0].question


# --------------------------------------------------------------------------
# the guarantee that did NOT relax
# --------------------------------------------------------------------------


def test_a_date_on_a_step_is_still_a_validation_error():
    """HLD §3. The solver is the only writer of dates — this is the one thing
    the tolerant boundary must never absorb."""
    for key in ("date", "start_date", "due_date", "scheduled_for", "target_date"):
        with pytest.raises(ValidationError):
            S.DecomposeStep.model_validate({"title": "Read chapter 1", "est_hours": 2, key: "2026-01-05"})


def test_a_date_on_a_milestone_is_still_a_validation_error():
    with pytest.raises(ValidationError):
        S.MilestoneSpec.model_validate({"title": "Pass 5 SD mocks", "phase": "Mocks", "target_date": "2026-02-01"})


def test_goal_dates_are_still_required():
    """`GoalSpec` is the one model that legitimately carries dates — and it must
    still carry them, or the lattice has no window to lay out."""
    with pytest.raises(ValidationError):
        S.GoalSpec.model_validate({"title": "Learn Rust", "horizon": "short", "weekly_hours": 6})


# --------------------------------------------------------------------------
# the other two model-shaped shapes that bite
# --------------------------------------------------------------------------


def test_a_bare_rejection_is_coerced_to_ok_rather_than_failing():
    """The determinism trap (HLD §8.6). A rejection with no deltas cannot change
    the solver's answer, so it is not a rejection — treating it as one would
    spin the loop to its cap and then surface `renegotiate` for no reason."""
    c = S.PlacementCritique.model_validate({"ok": False, "rationale": "feels wrong"})
    assert c.ok is True
    assert "could not change the solver's answer" in c.rationale


def test_a_rejection_with_deltas_is_honoured():
    c = S.PlacementCritique.model_validate(
        {
            "ok": False,
            "rationale": "keep step 1 off Monday",
            "deltas": [{"kind": "allowed_days", "task_id": "w0s0", "value": [2]}],
        }
    )
    assert c.ok is False
    assert c.deltas[0].kind == "allowed_days"


def test_decompose_accepts_either_nesting():
    """A model may key a week straight to its list of steps."""
    flat = {"steps": {"Week 1": [{"title": "Read", "est_hours": 2}]}}
    nested = {"steps": {"Week 1": {"steps": [{"title": "Read", "est_hours": 2}]}}}
    assert S.DecomposeSpec.model_validate(flat).steps["Week 1"][0].title == "Read"
    assert S.DecomposeSpec.model_validate(nested).steps["Week 1"][0].title == "Read"


# --------------------------------------------------------------------------
# the prompt now carries the schema
# --------------------------------------------------------------------------


def test_the_schema_brief_is_real_json_and_names_the_fields():
    brief = json.loads(schema_brief(S.IntakeSpec))
    props = brief["properties"]
    assert set(props) >= {
        "intent",
        "material_unknowns",
        "clarifying_questions",
        "referenced_goal_titles",
        "framing_line",
    }
    assert "confidence" not in props


def test_the_schema_brief_keeps_a_field_named_like_a_schema_keyword():
    """`DecomposeStep.title` collides with pydantic's `title` metadata key.

    The first cut of the compactor filtered by key name everywhere, so the step's
    `title` — a required field the model must supply — was silently deleted from
    the schema the model was shown.
    """
    brief = json.loads(schema_brief(S.DecomposeSpec))
    step = brief["$defs"]["DecomposeStep"]
    assert "title" in step["properties"]
    assert "title" in step["required"]


def test_the_schema_brief_is_compact_enough_to_inject():
    assert len(schema_brief(S.DecomposeSpec)) < 1200


def test_parse_still_handles_a_markdown_fence():
    fenced = '```json\n{"intent": "plan_day"}\n```'
    assert _parse(fenced, S.IntakeSpec).intent == "plan_day"
