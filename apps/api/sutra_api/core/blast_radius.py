"""What each write moves — the input to the replan tier.

This is the **only** thing the agent's `classify_change` needs from a route: a
list of horizons and whether a milestone moved. Everything else (tier, toaster
copy, the count) is derived from it in `app/core/staleness.py`.

v1 had this table too, but it lived in a relay the route called *after* its own
transaction and never waited on — so a relay failure lost the change silently,
and six call sites passed the action string where a `goal_id` belonged and
relayed nothing at all. v2 records the change **inside the mutation's
transaction**, so a change that committed is a change that was recorded. There
is no fire-and-forget step left to get wrong.

Choosing the radius is a product judgement, not arithmetic: it is "how much of
the user's plan did this sentence change". The values below kept v1's answers.
"""
from __future__ import annotations

#: `action -> (horizons_moved, milestone_moved)`.
#:
#: The horizon vocabulary is the *plan ladder* (`daily` … `yearly`), not the goal
#: sizing (`weekly`/`short`/`medium`/`long`) — v1 conflated the two and the
#: classifier's ranks are meaningless against the wrong one.
BLAST_RADIUS: dict[str, tuple[list[str], bool]] = {
    # ── goals ──────────────────────────────────────────────────────────────
    # Creating a goal lays a whole ladder, but nothing is *displaced*: the tiers
    # below it are new. Weekly-and-below is what escalates, and a new goal is
    # exactly that.
    "goal.create": (["weekly", "daily"], False),
    "goal.edit": (["weekly", "daily"], False),
    # Moving the dates rewrites every rung, and it changes the promise, so it
    # escalates.
    "goal.dates": (["monthly", "weekly", "daily"], True),
    # A drop is the largest blast radius there is: the whole ladder goes, and a
    # promise the user made to themselves is withdrawn.
    "goal.drop": (["yearly", "quarterly", "monthly", "weekly", "daily"], True),
    "goal.pause": (["monthly", "weekly", "daily"], False),
    # ── milestones — an outcome checkpoint, so always a promise ────────────
    "milestone.create": (["monthly"], True),
    "milestone.edit": (["monthly"], True),
    "milestone.delete": (["monthly"], True),
    # ── capacity ───────────────────────────────────────────────────────────
    # A blocker removes capacity for a range of days; the solver re-places
    # day-level work around it and nothing higher moves.
    "blocker.add": (["daily"], False),
    "blocker.edit": (["daily"], False),
    "blocker.delete": (["daily"], False),
    "timetable.add": (["daily"], False),
    "timetable.edit": (["daily"], False),
    "timetable.delete": (["daily"], False),
    # ── execution ──────────────────────────────────────────────────────────
    "plan_item.create": (["daily"], False),
    "plan_item.edit": (["daily"], False),
    "plan_item.complete": (["daily"], False),
    "daily_log.update": (["daily"], False),
    # Attaching a source changes what the coach knows, not where anything sits.
    "source.add": (["daily"], False),
    "source.edit": (["daily"], False),
    "source.remove": (["daily"], False),
}

#: Used when an action is not in the table. Daily-only, so an unrecognised write
#: lands in the *cheapest* tier and is applied silently — the alternative is
#: escalating an unknown action to a modal, which trains the user to dismiss
#: modals.
DEFAULT_RADIUS: tuple[list[str], bool] = (["daily"], False)


def radius_for(action: str) -> tuple[list[str], bool]:
    return BLAST_RADIUS.get(action, DEFAULT_RADIUS)


#: `ReplanAction.intent` → the radius it implies.
#:
#: `/plan/change` receives an *intent*, not an action string, because v2 collapsed
#: v1's nine tool actions into one intent-discriminated action (HLD §7). The
#: mapping is therefore intent-level, and it is coarser than the action table: an
#: `edit_goal` may move the dates or only the wording, and this cannot tell — so
#: it takes the wider radius, because escalating when unsure is the safe
#: direction (a modal the user dismisses costs less than a silent rewrite of
#: their timeline).
INTENT_RADIUS: dict[str, tuple[list[str], bool]] = {
    "add_goal": (["weekly", "daily"], False),
    "plan_day": (["daily"], False),
    "edit_goal": (["monthly", "weekly", "daily"], True),
    "drop_goal": (["yearly", "quarterly", "monthly", "weekly", "daily"], True),
    # A progress review re-reads the plan; if it changes anything, it changes
    # dates, and a date change escalates.
    "review_progress": (["monthly", "weekly", "daily"], True),
    "replan": (["monthly", "weekly", "daily"], True),
}


def radius_for_intent(intent: str) -> tuple[list[str], bool]:
    return INTENT_RADIUS.get(intent, DEFAULT_RADIUS)
