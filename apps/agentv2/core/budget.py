"""Budget checks between planner levels, and the code fallback. Pure.

The rule a level must keep: its children never exceed the capacity of the period
they sit in, and together they add up to what the parent allotted.
"""
from __future__ import annotations

from ..config import EFFORT_TOLERANCE_HOURS, TOTAL_UNDERSHOOT


def check_allocation(alloc: dict[str, float], capacity: dict[str, float], total: float) -> str | None:
    """None if `alloc` is usable; otherwise why not (the text goes back to the model)."""
    for pid, hours in alloc.items():
        if pid not in capacity:
            return f"{pid} was not offered"
        if hours < 0:
            return f"{pid} has negative hours"
        if hours > capacity[pid] + 1e-9:
            return f"{pid} gets {hours:g}h but only {capacity[pid]:g}h can be used there"
    got = sum(alloc.values())
    if got > total + EFFORT_TOLERANCE_HOURS:
        return f"allocated {got:g}h but only {total:g}h is needed"
    if got < total * (1 - TOTAL_UNDERSHOOT) - EFFORT_TOLERANCE_HOURS:
        return f"allocated {got:g}h but {total:g}h is needed"
    return None


def even_split(total: float, capacity: dict[str, float]) -> dict[str, float]:
    """Spread `total` evenly over the periods in order, pushing any overflow to later ones with room."""
    ids = [p for p, c in capacity.items() if c > 0]
    alloc = {p: 0.0 for p in ids}
    if not ids:
        return alloc
    share = total / len(ids)
    left = total
    for p in ids:
        take = min(share, capacity[p], left)
        alloc[p] += take
        left -= take
    for p in ids:  # overflow pass
        if left <= 1e-9:
            break
        take = min(capacity[p] - alloc[p], left)
        alloc[p] += take
        left -= take
    return {p: round(h, 2) for p, h in alloc.items() if h > 0}
