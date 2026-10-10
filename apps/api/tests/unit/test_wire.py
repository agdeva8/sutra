"""The wire shapes — the decisions `CONTRACT-RECONCILIATION.md` resolved.

These are the highest-value tests in the suite, because they pin the places where
`openapi.yaml` is **wrong** and v1 is right. A future reader who "fixes" one of
these to match the spec will fail here, and the docstring on each says why.

Uses a stand-in row rather than an ORM object: `wire` is pure, and these shapes
are about the mapping, not about SQLAlchemy.
"""
from __future__ import annotations

from datetime import UTC, date, datetime

from sutra_api.wire import (
    blocker,
    chat_message,
    goal_state,
    motivation,
    plan_item,
    plan_item_row,
    proposal_history,
    proposal_sse,
    source_list_row,
    source_row,
    source_upload_row,
    time_block,
)


class Row:
    """A duck-typed row — enough attributes for the serialiser under test."""

    def __init__(self, **kw):
        self.__dict__.update(kw)


def _ts(day: int = 10) -> datetime:
    return datetime(2026, 10, day, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Envelopes
# ---------------------------------------------------------------------------


class TestProposalShapes:
    def test_sse_nests_fields_under_args(self):
        """An SSE `tools` frame nests; `/chat/history` spreads flat."""
        row = Row(id="prop_1", action="create_goal", status="pending", args={"title": "Goa"})
        assert proposal_sse(row) == {
            "id": "prop_1",
            "action": "create_goal",
            "args": {"title": "Goa"},
            "status": "pending",
        }

    def test_history_spreads_args_flat(self):
        """`title` sits beside `status`, not under `args` — the client's
        `flatProposal` is the one place that reconciles the two spellings."""
        row = Row(id="prop_1", action="create_goal", status="pending", args={"title": "Goa"})
        out = proposal_history(row)
        assert out["title"] == "Goa"
        assert "args" not in out


class TestSourceVariants:
    def _row(self) -> Row:
        return Row(
            id="src_1",
            user_id="user_1",
            goal_id=None,
            goal_title="",
            kind="file",
            storage_path="sources/u/f.txt",
            original_filename="f.txt",
            content_type="text/plain",
            size=3,
            url="",
            text_excerpt="hey",
            is_deleted=False,
            created_at=_ts(),
        )

    def test_list_omits_text_excerpt(self):
        assert "text_excerpt" not in source_list_row(self._row())

    def test_single_includes_text_excerpt(self):
        assert source_row(self._row())["text_excerpt"] == "hey"

    def test_upload_adds_text_pending(self):
        out = source_upload_row(self._row(), text_pending=True)
        assert out["text_pending"] is True

    def test_a_null_goal_id_is_an_empty_string(self):
        """v1's `goal_id ?? ''` — the client treats this field as a string."""
        assert source_list_row(self._row())["goal_id"] == ""


# ---------------------------------------------------------------------------
# Plan items
# ---------------------------------------------------------------------------


class TestPlanItemVariants:
    def _row(self) -> Row:
        return Row(
            id="pi_1",
            goal_id="goal_1",
            horizon="daily",
            phase="",
            title="Read a chapter",
            note="",
            start_date=date(2026, 10, 10),
            end_date=date(2026, 10, 10),
            due_date=date(2026, 10, 10),
            weekly_hours=None,
            status="open",
            created_at=_ts(),
        )

    def test_post_response_omits_created_at(self):
        assert "created_at" not in plan_item(self._row(), with_created_at=False)

    def test_patch_response_includes_created_at(self):
        assert "created_at" in plan_item(self._row())

    def test_plan_item_row_coerces_dates_to_strings(self):
        """Called with both an agent `PlanItemRow` (already strings) and an ORM
        row (dates) — the two must not produce different types in one field."""
        out = plan_item_row(self._row())
        assert out["start_date"] == "2026-10-10"
        assert out["due_date"] == "2026-10-10"

    def test_plan_item_row_carries_no_id(self):
        """Mirrors the agent's `PlanItemRow`: an uncommitted plan has no rows."""
        assert "id" not in plan_item_row(self._row())


# ---------------------------------------------------------------------------
# Enums and values that the spec gets wrong
# ---------------------------------------------------------------------------


class TestContractCorrections:
    def test_goal_drift_status_is_v1_vocabulary(self):
        """Not the spec's `ahead|on_track|behind` — nothing has ever written
        those two, and the replan suggestions branch on `at_risk` exactly."""
        row = Row(
            id="goal_1",
            title="Switch jobs",
            horizon="short",
            status="active",
            why="",
            next_action="",
            target_date=None,
            start_date=None,
            drift_status="at_risk",
            weekly_hours=None,
            phase_objectives={},
        )
        assert goal_state(row)["drift_status"] == "at_risk"

    def test_motivation_cache_has_no_warming_value(self):
        """The spec invents `warming`. The real enum is `hit|miss|stale`, and
        anything but `hit` keeps the client polling for 60 seconds."""
        out = motivation("stuck", [], "hit", _ts().isoformat())
        assert out["cache"] == "hit"
        assert set(out) >= {"bucket", "items", "generated_at", "cache"}

    def test_blocker_serialises_a_null_end_date(self):
        """A blocker may be open-ended; the spec calls `end_date` required."""
        row = Row(
            id="blk_1",
            user_id="user_1",
            title="Goa trip",
            start_date=date(2026, 10, 12),
            end_date=None,
            note="",
            created_at=_ts(),
        )
        assert blocker(row)["end_date"] is None

    def test_time_block_times_are_hh_mm(self):
        """The column is a Postgres `time`; the wire is `HH:MM`."""
        from datetime import time

        row = Row(
            id="blk_1",
            user_id="user_1",
            block_date=date(2026, 10, 10),
            start_time=time(9, 30),
            end_time=time(11, 0),
            label="Standup",
            kind="commitment",
            source="manual",
            source_id=None,
            goal_id=None,
            goal_title="",
            note="",
            created_at=_ts(),
        )
        out = time_block(row)
        assert out["start_time"] == "09:30"
        assert out["end_time"] == "11:00"


class TestChatMessage:
    def test_carries_the_plugin_proposals(self):
        row = Row(
            id="msg_1",
            user_id="user_1",
            role="assistant",
            content="Here's a plan.",
            provider="gemini",
            created_at=_ts(),
        )
        prop = Row(id="prop_1", action="create_goal", status="pending", args={"title": "Goa"})
        out = chat_message(row, [prop])
        assert out["proposals"][0]["title"] == "Goa"
        assert out["provider"] == "gemini"
