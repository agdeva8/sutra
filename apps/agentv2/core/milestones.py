"""What a milestone replacement keeps and what it drops. Pure, so the rule is testable.

`ReplaceMilestones` carries the whole open set a goal should have after an edit. The writer has to
combine that with what the store already holds in **two** tables (the legacy `milestones` rows and
`calendar_blocks` milestone rows), and the rule must be the same in both: a done milestone is kept
as it is, and every open milestone the incoming set does not repeat is removed.
"""
from __future__ import annotations

from collections.abc import Iterable


def replacement_targets(existing: Iterable[tuple[str, bool]]) -> tuple[set[str], set[str]]:
    """`(keep, replace)` from `(milestone_id, is_done)` pairs.

    Done is kept because it records work already achieved; re-dating a finished milestone would
    rewrite history. Everything else is replaced wholesale, including a milestone the new set keeps
    with the same id but a new date: the old dated row goes and the new one is written.
    """
    keep: set[str] = set()
    replace: set[str] = set()
    for milestone_id, done in existing:
        (keep if done else replace).add(milestone_id)
    return keep, replace
