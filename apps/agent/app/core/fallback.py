"""Structural placement — the ONLY fallback. PURE, ~15 lines of logic.

Deliberately dumb: every unplaced task keeps its `window_start`. It is worse
than the solver but *obviously* correct, which is what a fallback should be.

There is no hand-written greedy here on purpose (HLD §8.4): a second placement
algorithm is a second thing to maintain, test, and keep consistent with the
model's objective, and it exists only for a path that should be rare.
"""
from __future__ import annotations

from app.contracts.schemas import HorizonTask, PlaceResult, Slot


def structural_place(
    tasks: list[HorizonTask],
    *,
    reason: str = "",
    unplaced: list[str] | None = None,
) -> PlaceResult:
    """Keep every task at its window start. Never drops a task."""
    slots: list[Slot] = []
    for t in tasks:
        slots.append(Slot(task_id=t.id, date=t.window_start, hours=t.est_hours))
    return PlaceResult(
        feasible=False,
        slots=slots,
        unscheduled=list(unplaced or []),
        solver="structural",
        detail=reason or "structural placement — window start retained",
    )
