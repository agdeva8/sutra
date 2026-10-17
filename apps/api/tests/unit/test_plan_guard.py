"""A background re-plan leaves a goal whose schedule build is live alone.

`live_build_goal_ids` decides which goals hold the lease; `without_live_builds` is what the two
background paths hand `agentv2`, so the loops inside it never pick those goals up.
"""
from datetime import date, datetime, time, timedelta, timezone

from agentv2.config import BLOCK_TENTATIVE
from agentv2.core.context import BlockRow, Context, GoalHours, PlanWeekRow
from sutra_api.api.plan import PLAN_LEASE
from sutra_api.models import PLAN_PLANNING, PLAN_READY
from sutra_api.plan_guard import live_build_goal_ids, without_live_builds

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
DAY = date(2026, 10, 15)


def _block(block_id, *, goal_id, status):
    return BlockRow(
        id=block_id, day=DAY, start=time(9), end=time(10), status=status, goal_id=goal_id
    )


def test_a_live_build_is_named():
    rows = [("g1", PLAN_PLANNING, NOW - timedelta(minutes=1)), ("g2", PLAN_READY, None)]
    assert live_build_goal_ids(rows, NOW) == frozenset({"g1"})


def test_an_expired_lease_is_not_live():
    rows = [("g1", PLAN_PLANNING, NOW - PLAN_LEASE - timedelta(seconds=1))]
    assert live_build_goal_ids(rows, NOW) == frozenset()


def test_a_status_without_a_start_time_is_not_trusted():
    rows = [("g1", PLAN_PLANNING, None)]
    assert live_build_goal_ids(rows, NOW) == frozenset()


def test_no_live_builds_leaves_the_context_untouched():
    ctx = Context(goal_hours={"g1": GoalHours(4, 1)})
    assert without_live_builds(ctx, frozenset()) is ctx


def test_a_live_goal_drops_its_tentative_rows_but_keeps_committed_ones():
    ctx = Context(
        blocks=(
            _block("t1", goal_id="g1", status=BLOCK_TENTATIVE),
            _block("c1", goal_id="g1", status="committed"),
            _block("t2", goal_id="g2", status=BLOCK_TENTATIVE),
        )
    )
    out = without_live_builds(ctx, frozenset({"g1"}))
    assert [b.id for b in out.blocks] == ["c1", "t2"]


def test_a_live_goal_drops_its_weeks_hours_and_expansions():
    ctx = Context(
        plan_weeks=(
            PlanWeekRow("g1", "G1", DAY, "focus", 4),
            PlanWeekRow("g2", "G2", DAY, "focus", 3),
        ),
        expanded_weeks=frozenset({("g1", DAY), ("g2", DAY)}),
        goal_hours={"g1": GoalHours(4, 1), "g2": GoalHours(3, 0)},
    )
    out = without_live_builds(ctx, frozenset({"g1"}))
    assert [w.goal_id for w in out.plan_weeks] == ["g2"]
    assert out.expanded_weeks == frozenset({("g2", DAY)})
    assert set(out.goal_hours) == {"g2"}
