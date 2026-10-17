"""Does confirming a proposal change the plan the goal's sessions were built from? Pure.

A confirmed proposal is applied through the gateway, but applying it does not by itself rebuild the
sessions that were planned around the old values. When the change moves the goal's deadline, its
weekly hours, or its milestones, those sessions are now planned for a goal that no longer exists, so
the confirm route re-plans the goal in the same request. Everything else (a rename, a title tweak, a
block, a reminder) leaves the sessions valid and must not pay for a planner run.

Kept separate from the route so the decision is unit-testable without a database or a model.
"""
from __future__ import annotations

from collections.abc import Mapping

#: Proposal actions that always change what a session is planned against.
_PLAN_CHANGING_ACTIONS = frozenset({
    "set_goal_dates",
    "replace_milestones",
    "add_milestone",
})

#: `update_goal` fields that invalidate planned sessions when they are present and non-empty.
_PLAN_CHANGING_FIELDS = ("target_date", "weekly_hours")


def needs_replan(action: str, args: Mapping | None) -> bool:
    """Whether applying this confirmed proposal requires re-planning its goal's sessions.

    Conservative on purpose: a missing or unreadable payload does not trigger a planner run, because
    the proposal's own handler decides whether it changed anything, and a spurious re-plan would spend
    the user's time and the shared model budget.
    """
    data = args if isinstance(args, Mapping) else {}
    if action in _PLAN_CHANGING_ACTIONS:
        return True
    # A gateway proposal carries the change itself rather than an action name.
    change = data.get("change")
    if isinstance(change, Mapping) and change.get("kind") in _PLAN_CHANGING_ACTIONS:
        return True
    if action == "update_goal":
        # A `status` change to dropped/paused goes through its own path and is not a plan edit.
        if data.get("status") in ("dropped", "paused"):
            return False
        if data.get("milestones") or data.get("replace_milestones"):
            return True
        for field in _PLAN_CHANGING_FIELDS:
            if field in data and data[field] not in (None, ""):
                return True
    return False
