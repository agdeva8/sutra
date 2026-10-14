"""Step 1: the gateway and validator, no model.

Feeds hand-written change sets through the real gateway against an in-memory
store, so the output shows what is applied, what becomes a proposal, and what
is rejected.
"""
from __future__ import annotations

from datetime import date, time

from ..core.context import BlockRow, Context
from ..contracts import AddBlock, AddGoal, AddTask, ChangeSet, MoveBlock, Origin
from ..gateway import apply
from ..gateway.memory import InMemoryStore

THU = date(2026, 10, 15)


async def run() -> None:
    store = InMemoryStore(Context(
        goal_ids=frozenset({"g_career"}),
        blocks=(BlockRow("b_wedding", THU, time(16), time(20), "committed"),),
    ))
    origin = Origin(source="scratch", ref="entry_1")

    cases = {
        "1. Q4 deck task under an existing goal + a new tentative block": ChangeSet(origin=origin, changes=[
            AddTask(id="t1", goal_id="g_career", title="Q4 deck", effort_hours=3),
            AddBlock(id="b1", title="Q4 deck", day=THU, start=time(9), end=time(12)),
        ]),
        "2. Move the committed wedding block (should become a proposal)": ChangeSet(origin=origin, changes=[
            MoveBlock(block_id="b_wedding", day=THU, start=time(17), end=time(21)),
        ]),
        "3. Task for a goal that does not exist (should be rejected)": ChangeSet(origin=origin, changes=[
            AddTask(id="t2", goal_id="g_nope", title="Ghost", effort_hours=1),
        ]),
        "4. Tentative block on top of the wedding (should be rejected)": ChangeSet(origin=origin, changes=[
            AddBlock(id="b2", title="Overlap", day=THU, start=time(18), end=time(19)),
        ]),
        "5. New goal + task for it in the same change set": ChangeSet(origin=origin, changes=[
            AddGoal(id="g_drive", title="Learn driving"),
            AddTask(id="t3", goal_id="g_drive", title="Book lessons", effort_hours=1),
        ]),
    }
    for name, cs in cases.items():
        res = await apply(cs, store)
        print(f"\n{name}\n  -> {type(res).__name__}")
        if hasattr(res, "violations"):
            for v in res.violations:
                print(f"     [{v.rule}] change {v.change_index}: {v.message}")
        else:
            print(f"     applied={res.applied} proposed={[(p.change_index, p.reason) for p in res.proposed]}")

    print(f"\nstore: goals={sorted(store.goals)} tasks={sorted(store.tasks)} "
          f"blocks={sorted(store.blocks)} proposals={len(store.proposals)} "
          f"audit={len(store.audit)} rejects={len(store.rejects)}")


