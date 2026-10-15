"""The month level asks only for hours that can fit, so an over-long goal does not burn every retry."""
import importlib
import re
from datetime import date

from agentv2.contracts.planner import GoalSpec, MonthItem, MonthPlan, WeekItem, WeekPlan

week = importlib.import_module("agentv2.planner.week")


def _usable(n_weeks: int, hours: float) -> dict[str, float]:
    start = date(2026, 10, 19)
    from datetime import timedelta
    return {f"{week.WEEK_PREFIX}{(start + timedelta(weeks=i)).isoformat()}": hours for i in range(n_weeks)}


def test_an_impossible_total_is_capped_to_what_fits_and_the_rest_is_shortfall(monkeypatch):
    usable = _usable(12, 10.0)  # 120h can fit
    goal = GoalSpec(id="g", title="Switch job", total_hours=200)
    asked: list[float] = []

    def fake(chat, system, user, schema, *a):
        if schema is MonthPlan:
            cap: dict[str, float] = {}
            for wid, h in usable.items():
                cap[week._month_of(wid)] = cap.get(week._month_of(wid), 0.0) + h
            asked.append(float(re.search(r"(\d+(?:\.\d+)?)\s*h", user).group(1)) if re.search(r"(\d+(?:\.\d+)?)\s*h", user) else -1)
            return MonthPlan(months=[MonthItem(month_id=m, hours=h, focus=f"focus {m}") for m, h in cap.items()])
        listed = re.findall(r"- (wk_[\d-]+|w[^:]*): ([\d.]+)h", user)
        return WeekPlan(weeks=[WeekItem(week_id=w, focus="f", hours=float(h)) for w, h in listed])

    monkeypatch.setattr(week, "complete_json", fake)
    months, meta, how = week._plan_months(None, goal, usable)
    assert how == "model" and round(sum(months.values()), 2) == 120.0
    assert len(asked) == 1  # one call, not three failed retries

    monkeypatch.setattr(week, "free_hours_by_week", lambda ctx, now, n: {date.fromisoformat(w[len(week.WEEK_PREFIX):]): 100.0 for w in usable})
    monkeypatch.setattr(week, "GOAL_MAX_SHARE_OF_FREE", 0.1)
    from agentv2.core.context import Context
    from datetime import datetime
    r = week.plan_weeks(None, goal, Context(today=date(2026, 10, 15)), datetime(2026, 10, 15, 9))
    assert r.how == "month(model)+week" and round(r.shortfall, 2) == 80.0
    assert [a.week for a in r.allocs] == sorted(a.week for a in r.allocs)
