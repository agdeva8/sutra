"""A plan's outcomes round-trip through the existing `description` column.

The gateway writes them one per line and `Context` reads them back into a `PlanWeekRow` /
`PlanMonthRow`; `plan_sections` is where the coach actually sees them. No migration.
"""
import asyncio
from datetime import date, datetime

from agentv2.contracts.changes import AddPlanMonth, AddPlanWeek, Origin
from agentv2.core.context import Context, PlanMonthRow, PlanWeekRow
from agentv2.core.plan_context import plan_sections
from sutra_api.agent_store import SqlStore, _plan_outcomes

NOW = datetime(2026, 10, 19, 9, 0)
MONDAY = date(2026, 10, 19)
ORIGIN = Origin(source="goal")


class FakeSession:
    def __init__(self):
        self.added = []

    def add(self, row):
        self.added.append(row)

    async def flush(self):
        pass


def _write(change) -> list:
    s = FakeSession()
    asyncio.run(SqlStore(s, "u", today=MONDAY).write(change, ORIGIN))
    return s.added


def test_week_outcomes_are_stored_one_per_line_in_description():
    rows = _write(AddPlanWeek(id="pw", goal_id="g", week_start=MONDAY, focus="Applications",
                              hours=6, why="Ramp up.", outcomes=["20 applications sent", "2 mock interviews"]))
    assert len(rows) == 1
    assert rows[0].description == "20 applications sent\n2 mock interviews"
    assert list(_plan_outcomes(rows[0].description)) == ["20 applications sent", "2 mock interviews"]


def test_month_outcomes_are_stored_one_per_line_in_description():
    rows = _write(AddPlanMonth(id="pm", goal_id="g", month_start=MONDAY, focus="Foundations",
                               hours=24, outcomes=["System design notes done"]))
    assert rows[0].description == "System design notes done"


def test_a_plan_without_outcomes_writes_no_description():
    assert _write(AddPlanWeek(id="pw", goal_id="g", week_start=MONDAY, focus="f", hours=1))[0].description is None


def test_the_coach_reads_the_outcomes_back_in_its_plan_block():
    ctx = Context(today=MONDAY, goal_titles={"g": "Backend job"}, plan_months=(
        PlanMonthRow("g", "Backend job", MONDAY.replace(day=1), "Foundations", 20, "", ("Design notes done",)),),
        plan_weeks=(PlanWeekRow("g", "Backend job", MONDAY, "Applications", 6, "", ("20 applications sent",)),))
    text = "\n".join(plan_sections(ctx, NOW))
    assert "THIS MONTH" in text and "Design notes done" in text
    assert "THIS WEEK" in text and "20 applications sent" in text
