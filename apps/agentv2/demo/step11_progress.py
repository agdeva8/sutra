"""Progress: code computes the numbers, the model judges them. Weeks slip in October, the month still lands."""
from __future__ import annotations

from datetime import date, timedelta

from ..config import load_settings
from ..model import build_model
from ..progress import MilestoneRow, PlanRow, build_goal_facts, judge_goal
from ..progress.judge import facts_text

TODAY = date(2026, 10, 31)


def _days(week: date, hours_done: list[tuple[float, float]]) -> list[PlanRow]:
    return [PlanRow(f"d{week:%m%d}{i}", "daily", f"session {i}", week + timedelta(days=i * 2), None, h, done)
            for i, (h, done) in enumerate(hours_done)]


async def run() -> None:
    wk = [date(2026, 10, 5), date(2026, 10, 12), date(2026, 10, 19), date(2026, 10, 26), date(2026, 11, 2)]
    rows = [
        PlanRow("pm_oct", "monthly", "Foundations", date(2026, 10, 1), date(2026, 10, 31), 16),
        PlanRow("pm_nov", "monthly", "Core patterns", date(2026, 11, 1), date(2026, 11, 30), 20),
        *[PlanRow(f"pw_{w:%m%d}", "weekly", "week", w, w + timedelta(days=6), 4) for w in wk],
        # Week of 5 Oct: only 1 of 4h done. The next two weeks make it up (6h each against 4h planned).
        *_days(wk[0], [(2, 1), (2, 0)]),
        *_days(wk[1], [(2, 2), (2, 2)]),
        *_days(wk[2], [(2, 2), (2, 2), (3, 3)]),  # a make-up session for the slipped first week
        *_days(wk[3], [(2, 2), (2, 2)]),
        *_days(wk[4], [(2, 0), (2, 0)]),
    ]
    miles = [MilestoneRow("ms_1", "Finish data structures", date(2026, 11, 19), False)]
    facts = build_goal_facts("g", "Crack the Google SWE interview", date(2027, 2, 3), rows, miles, TODAY)
    print(facts_text(facts), "\n")
    v = judge_goal(build_model(load_settings()), facts)
    print("GOAL      ", v.status, "-", v.note)
    for l in v.levels:
        print(f"  {l.id:<10}", l.status, "-", l.note)
    for m in v.milestones:
        print(f"  {m.id:<10}", m.status, "-", m.note)
