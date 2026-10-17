"""Day items have three kinds: timed focus work, quotas and multi-day work.

Old replies still parse as focus; code checks the week adds up whichever kind is used; and the
week level says when it cannot hold the pace the user asked for.
"""
from datetime import date, datetime, time, timedelta

import pytest

from agentv2.contracts import ChangeSet, Origin
from agentv2.contracts.blocks import AddItem, TaskBlock
from agentv2.contracts.planner import DayItem, DayPlan, GoalSpec, WeekItem, WeekPlan
from agentv2.core.budget import check_allocation
from agentv2.core.context import Context
from agentv2.core.validate import RULE_RECURRING, validate
from agentv2.planner import day, week
from agentv2.planner.week import WeekAlloc, WeekResult

MONDAY = date(2026, 10, 19)
NOW = datetime(2026, 10, 19, 9, 0)
WEEK = MONDAY


def day_id(d: date) -> str:
    return f"{day.DAY_PREFIX}{d.isoformat()}"


def spec(**kw) -> GoalSpec:
    base = dict(id="g", title="Switch to a backend job", total_hours=10)
    return GoalSpec(**{**base, **kw})


def alloc(hours: float, why: str = "") -> WeekAlloc:
    return WeekAlloc(MONDAY, "Applications", hours, why)


def fake_day_model(plan: DayPlan):
    """complete_json that answers the day prompt, and declines the (unneeded) slot prompt."""
    def fake(chat, system, user, schema, *a):
        return plan if schema is DayPlan else None
    return fake


# ---------------------------------------------------------------------------
# Backward compatibility
# ---------------------------------------------------------------------------


def test_an_old_day_reply_without_kinds_parses_as_focus():
    plan = DayPlan.model_validate_json('{"sessions":[{"day_id":"d_2026-10-19","title":"Mock interview","hours":2}]}')
    item = plan.sessions[0]
    assert item.kind == "focus"
    assert item.count == 0 and item.minutes_each == 0
    assert item.weekdays == [] and item.days == []


# ---------------------------------------------------------------------------
# The kinds map onto 4-kind task blocks
# ---------------------------------------------------------------------------


def test_a_quota_becomes_one_repeating_task_block_with_its_count(monkeypatch):
    plan = DayPlan(sessions=[DayItem(
        day_id=day_id(MONDAY), title="Send 5 applications", hours=10, kind="quota",
        count=5, minutes_each=30, weekdays=[1, 2, 3, 4])])
    monkeypatch.setattr(day, "complete_json", fake_day_model(plan))
    ctx = Context(today=NOW.date())
    changes, _, how = day.plan_day_level(None, spec(), week.WeekAlloc(MONDAY, "Applications", 10.0), ctx, NOW)

    blocks = [c.block for c in changes if isinstance(c, AddItem)]
    assert how == "model" and len(blocks) == 1
    b = blocks[0]
    assert b.block_kind == "task" and b.title == "Send 5 applications"
    assert b.day == date(2026, 10, 20)  # the first quota day (Tuesday)
    assert b.start is None and b.end is None  # anytime, no time block
    assert b.repeat.weekdays == [1, 2, 3, 4]
    assert b.repeat.until == date(2026, 10, 23)  # the last quota day (Friday)
    assert b.quota == 5
    assert b.effort_hours == 2.5  # 5 × 30 min, per day


def test_a_multi_day_item_becomes_one_task_block_spanning_its_days(monkeypatch):
    plan = DayPlan(sessions=[DayItem(
        day_id=day_id(MONDAY), title="System design: caching", hours=4, kind="multi_day",
        days=[day_id(date(2026, 10, 20)), day_id(date(2026, 10, 21))])])
    monkeypatch.setattr(day, "complete_json", fake_day_model(plan))
    ctx = Context(today=NOW.date())
    changes, _, _ = day.plan_day_level(None, spec(), week.WeekAlloc(MONDAY, "System design", 4.0), ctx, NOW)

    blocks = [c.block for c in changes if isinstance(c, AddItem)]
    assert len(blocks) == 1
    b = blocks[0]
    assert b.day == date(2026, 10, 20) and b.start is None and b.end is None
    assert b.repeat.weekdays == [1, 2]
    assert b.repeat.until == date(2026, 10, 21)
    assert b.effort_hours == 4  # the total, split evenly over the days
    assert b.quota is None


def test_a_quota_with_no_count_is_sent_back(monkeypatch):
    bad = DayPlan(sessions=[DayItem(
        day_id=day_id(MONDAY), title="Apply", hours=2.5, kind="quota",
        count=0, minutes_each=30, weekdays=[1])])
    good = DayPlan(sessions=[DayItem(
        day_id=day_id(MONDAY), title="Apply", hours=2.5, kind="quota",
        count=5, minutes_each=30, weekdays=[1])])
    replies = iter([bad, good])
    monkeypatch.setattr(day, "complete_json", lambda *a: next(replies))
    ctx = Context(today=NOW.date())
    changes, _, how = day.plan_day_level(None, spec(), week.WeekAlloc(MONDAY, "Applications", 2.5), ctx, NOW)
    assert how == "model"
    assert [c.block.quota for c in changes if isinstance(c, AddItem)] == [5]


# ---------------------------------------------------------------------------
# The week's effort adds up with mixed kinds
# ---------------------------------------------------------------------------


def _effort(items: list[DayItem]) -> dict[str, float]:
    out: dict[str, float] = {}
    for item in items:
        for did, hours in day._per_day_effort(item, WEEK).items():
            out[did] = out.get(did, 0.0) + hours
    return out


def test_mixed_kinds_within_the_day_caps_and_the_week_total():
    items = [
        DayItem(day_id=day_id(MONDAY), title="Mock interview", hours=1),
        DayItem(day_id=day_id(MONDAY), title="Send 5 applications", hours=10, kind="quota",
                count=5, minutes_each=30, weekdays=[0, 1, 2, 3]),
        DayItem(day_id=day_id(MONDAY), title="System design", hours=3, kind="multi_day",
                days=[day_id(date(2026, 10, 20)), day_id(date(2026, 10, 21))]),
    ]
    # 1h focus + 2.5h quota on Mon; 2.5h quota + 1.5h multi-day on Tue/Wed; 2.5h quota Thu.
    assert check_allocation(_effort(items), {day_id(MONDAY + timedelta(days=i)): 4.0 for i in range(7)}, 14.0) is None


def test_mixed_kinds_over_a_day_cap_are_rejected():
    items = [
        DayItem(day_id=day_id(MONDAY), title="Deep work", hours=2),
        DayItem(day_id=day_id(MONDAY), title="20 applications", hours=10, kind="quota",
                count=20, minutes_each=30, weekdays=[0]),
    ]
    problem = check_allocation(_effort(items), {day_id(MONDAY): 4.0}, 12.0)
    assert problem and "only 4h" in problem


# ---------------------------------------------------------------------------
# An honest short week
# ---------------------------------------------------------------------------


def test_a_short_week_says_so_in_its_why_and_in_the_notes(monkeypatch):
    monkeypatch.setattr(week, "free_hours_by_day", lambda ctx, now, w: {
        w + timedelta(days=i): (0.0 if i in (3, 4) else 3.0) for i in range(7)})
    res = WeekResult([alloc(6.0, "Applications ramp up.")], "model", 0.0)
    week._note_shortfalls(res, spec(weekly_hours=8), Context(today=NOW.date()), NOW,
                          {f"{week.WEEK_PREFIX}{MONDAY.isoformat()}": 6.0}, 1.0)
    a = res.allocs[0]
    assert "Only 6 of 8h fit this week" in a.why
    assert "Thu, Fri" in a.why
    assert res.shortfalls and res.shortfalls[0].startswith("19 Oct:")


def test_a_week_that_gets_the_pace_is_not_nagged(monkeypatch):
    monkeypatch.setattr(week, "free_hours_by_day", lambda ctx, now, w: {w + timedelta(days=i): 3.0 for i in range(7)})
    res = WeekResult([alloc(8.0, "Full week.")], "model", 0.0)
    week._note_shortfalls(res, spec(weekly_hours=8), Context(today=NOW.date()), NOW,
                          {f"{week.WEEK_PREFIX}{MONDAY.isoformat()}": 8.0}, 1.0)
    assert res.allocs[0].why == "Full week." and res.shortfalls == []


# ---------------------------------------------------------------------------
# The cap depends on how many goals share the time
# ---------------------------------------------------------------------------


def _plan_one_week(monkeypatch, ctx: Context) -> WeekResult:
    monkeypatch.setattr(week, "free_hours_by_week", lambda ctx, now, n: {MONDAY: 8.0})

    def fake(chat, system, user, schema, *a):
        listed = __import__("re").findall(r"- (wk_[\d-]+|w[^:]*): ([\d.]+)h", user)
        return WeekPlan(weeks=[WeekItem(week_id=w, focus="f", hours=float(h), outcomes=["8h done"])
                               for w, h in listed])

    monkeypatch.setattr(week, "complete_json", fake)
    goal = spec(total_hours=8, deadline=MONDAY + timedelta(days=5))
    return week.plan_weeks(None, goal, ctx, NOW)


def test_a_lone_goal_may_use_all_the_free_time(monkeypatch):
    r = _plan_one_week(monkeypatch, Context(today=NOW.date(), active_goal_ids=frozenset({"g"})))
    assert round(sum(a.hours for a in r.allocs), 2) == 8.0


def test_two_active_goals_share_the_free_time(monkeypatch):
    r = _plan_one_week(monkeypatch, Context(today=NOW.date(), active_goal_ids=frozenset({"g", "h"})))
    assert round(sum(a.hours for a in r.allocs), 2) == 4.0
    assert r.shortfall == 4.0


# ---------------------------------------------------------------------------
# The critic reads the same kinds the day level writes
# ---------------------------------------------------------------------------


def test_the_critic_sees_timed_quota_and_multi_day_items():
    from agentv2.planner.critic import _describe

    def item(title="Work", **kw):
        return AddItem(block=TaskBlock(id="t", title=title, goal_id="g", day=MONDAY, **kw))

    text = _describe([
        item(start=time(9, 0), end=time(10, 0)),
        item(title="Apply", quota=3, effort_hours=1.5),
        item(title="Caching", repeat=day.Repeat(weekdays=[1, 2], until=date(2026, 10, 21))),
    ])
    assert "Mon 19 Oct 09:00-10:00" in text
    assert "any time, 3×/day" in text
    assert "any time, across 2 days" in text
    assert "(nothing placed)" not in text


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_a_quota_below_one_is_rejected_by_the_contract():
    with pytest.raises(Exception):
        TaskBlock(id="t", title="Apply", goal_id="g", day=MONDAY, quota=0)


def test_validate_rejects_a_quota_below_one_that_bypassed_the_contract():
    blk = TaskBlock.model_construct(id="t", title="Apply", goal_id="g", day=MONDAY, quota=0,
                                    repeat=None, block_kind="task", done=False, state="open",
                                    placed_by="planner", quota_done={})
    cs = ChangeSet.model_construct(origin=Origin(source="manual"), changes=[AddItem.model_construct(block=blk)])
    rules = [v.rule for v in validate(cs, Context(goal_ids=frozenset({"g"}), today=MONDAY))]
    assert RULE_RECURRING in rules


def test_the_critic_is_told_which_days_can_still_take_work():
    from agentv2.prompts.planner import critic_user

    told = critic_user("Switch jobs", "Resume", "- Sat 17 Oct 09:00-11:00  Draft", "Sat 17 Oct, Sun 18 Oct")
    assert "Days this week that can take work: Sat 17 Oct, Sun 18 Oct." in told
    assert "never ask to use it" in told
    assert "can take work" not in critic_user("Switch jobs", "Resume", "- Sat 17 Oct 09:00-11:00  Draft")
