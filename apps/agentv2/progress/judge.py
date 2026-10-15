"""The progress judgement: one model call per goal, from code's facts to a status and an honest note."""
from __future__ import annotations

from ..contracts.progress import GoalVerdict
from ..llm import complete_json
from ..prompts.progress import PROGRESS_SYSTEM, progress_user
from .facts import GoalFacts, LevelFacts


def _level_line(l: LevelFacts) -> str:
    return (f"- {l.id} ({l.label}, {l.when}): planned {l.planned:g}h, scheduled {l.scheduled:g}h, "
            f"due so far {l.due:g}h, finished {l.done:g}h")


def facts_text(f: GoalFacts) -> str:
    """The facts as plain lines, with ids the verdict copies back."""
    lines = [
        f"Goal: {f.title}",
        f"Today: {f.today:%A %d %b %Y}. Deadline: {f.deadline.isoformat() if f.deadline else 'none'}"
        + (f" ({f.weeks_left:g} weeks left)" if f.weeks_left is not None else ""),
        f"Whole plan: {f.total_planned:g}h across all weeks ({f.scheduled_in_days:g}h already broken into days), {f.total_done:g}h finished ({f.pct_done}%), "
        f"{f.due_so_far:g}h was due by now ({f.pct_expected}%), {f.remaining:g}h remaining.",
    ]
    if f.months:
        lines += ["", "Months:"] + [_level_line(m) for m in f.months]
    if f.weeks:
        lines += ["", "Weeks:"] + [_level_line(w) for w in f.weeks]
    if f.milestones:
        lines += ["", "Milestones:"] + [
            f"- {m.id} ({m.title}): {'done' if m.done else 'open'}, "
            f"{'no date' if m.target is None else f'{m.target:%d %b} ({m.days_left} days left)'}, "
            f"{m.hours_before:g}h scheduled before it, {m.done_before:g}h of that finished"
            for m in f.milestones
        ]
    return "\n".join(lines)


def judge_goal(chat, facts: GoalFacts) -> GoalVerdict | None:
    """None when the model's reply is unusable: the caller then shows the numbers without a verdict."""
    return complete_json(chat, PROGRESS_SYSTEM, progress_user(facts_text(facts)), GoalVerdict)
