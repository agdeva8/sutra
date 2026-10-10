"""A small terminal UI for driving the agent end to end.

Run it:

    cd apps/agent && .venv/bin/python -m app.tui

No network and no database are required: with no API key configured the agent
uses its deterministic stub, so every path — clarify, review loop, slim and
escalated replans, renegotiation, staleness — is exercisable offline.

Commands
    /plan <message>       plan a goal (default when you just type)
    /replan <change>      report a change and see the tier it lands in
    /staleness            the refresh-button count and the toaster strings
    /deltas               the constraint deltas currently applied
    /rejects              per-stage rejection log (observability)
    /demo                 walk every functionality in one go
    /help, /quit
"""
from __future__ import annotations

import asyncio
import shutil
import sys
from dataclasses import dataclass, field

from app.core import staleness as st
from app.core.util import add_days, now_utc, today_utc
from app.graph.build import run_plan
from app.llm.client import get_complete, resolve_provider, stub_complete
from app.observability import configure_tracing

W = min(96, shutil.get_terminal_size((96, 40)).columns)

# --------------------------------------------------------------------------
# rendering helpers — no third-party deps
# --------------------------------------------------------------------------

BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"


def _use_colour() -> bool:
    return sys.stdout.isatty()


def c(text: str, colour: str) -> str:
    return f"{colour}{text}{RESET}" if _use_colour() else text


def rule(char: str = "─") -> str:
    return c(char * W, DIM)


def head(title: str) -> None:
    print()
    print(rule())
    print(c(f"  {title}", BOLD))
    print(rule())


def kv(label: str, value: object, indent: int = 2) -> None:
    print(f"{' ' * indent}{c(label.ljust(16), DIM)} {value}")


HORIZON_ORDER = ("yearly", "quarterly", "monthly", "weekly", "daily")
HORIZON_LABEL = {
    "yearly": "Year Plan",
    "quarterly": "Quarterly Plan",
    "monthly": "Monthly Plan / Milestones",
    "weekly": "Weekly Plan",
    "daily": "Daily Tasks",
}


def render_plan(items: list[dict], *, daily_limit: int = 12) -> None:
    """The plan as the execution ladder, coarsest first."""
    if not items:
        print(c("  (no plan items)", DIM))
        return
    for horizon in HORIZON_ORDER:
        rows = [i for i in items if i.get("horizon") == horizon]
        if not rows:
            continue
        print()
        print(c(f"  {HORIZON_LABEL[horizon]}  ({len(rows)})", CYAN))
        shown = rows[:daily_limit] if horizon == "daily" else rows
        for r in shown:
            when = r.get("due_date") or r.get("start_date") or "—"
            end = r.get("end_date")
            span = f"{when} → {end}" if end and end != when else when
            note = f"  {c(r['note'], DIM)}" if r.get("note") else ""
            print(f"    {span.ljust(24)} {r.get('title', '')}{note}")
        if len(rows) > len(shown):
            print(c(f"    …and {len(rows) - len(shown)} more", DIM))


def render_placement(place: dict | None, tasks: list[dict]) -> None:
    if not place:
        return
    by_id = {t["id"]: t for t in tasks}
    slots = place.get("slots") or []
    unscheduled = set(place.get("unscheduled") or [])

    print()
    print(
        f"  {c('solver', DIM)} {place.get('solver')}   "
        f"{c('detail', DIM)} {place.get('detail', '')}"
    )
    for s in sorted(slots, key=lambda s: (s["date"], s["task_id"]))[:20]:
        t = by_id.get(s["task_id"], {})
        flag = c("  (over capacity)", YELLOW) if s["task_id"] in unscheduled else ""
        print(f"    {s['date']}  {s['hours']:>4}h  {t.get('title', s['task_id'])}{flag}")
    if len(slots) > 20:
        print(c(f"    …and {len(slots) - 20} more", DIM))


def render_result(res: dict, *, tasks: list[dict] | None = None) -> None:
    kind = res.get("kind")
    colour = {"ok": GREEN, "clarify": CYAN, "renegotiate": YELLOW}.get(kind, RED)

    head(f"result: {c(str(kind).upper(), colour)}")
    if res.get("prose"):
        for line in _wrap(res["prose"], W - 4):
            print(f"  {line}")
    if res.get("reason"):
        print(f"  {c(res['reason'], DIM)}")

    if kind == "clarify":
        print()
        for n, q in enumerate(res.get("questions") or [], start=1):
            print(f"  {c(f'? {n}.', CYAN)} {q['question']}")
            for i, o in enumerate(q.get("options") or [], start=1):
                print(f"       {c(str(i), CYAN)}) {o}")
        print()
        print(c("  answer below: type a number, or your own words.", DIM))

    if kind == "ok":
        if res.get("plan_items"):
            render_plan(res["plan_items"])
        render_placement(res.get("place"), tasks or [])
        if res.get("review_rounds"):
            print()
            kv("review rounds", res["review_rounds"])
        if res.get("proposals"):
            print()
            print(c("  proposals", CYAN))
            for p in res["proposals"]:
                print(f"    {p.get('intent')}  {c(p.get('rationale', ''), DIM)}")

    if res.get("rejects"):
        print()
        print(c(f"  rejects ({len(res['rejects'])})", DIM))
        for r in res["rejects"][:4]:
            print(c(f"    [{r.get('stage')}] {str(r.get('reason'))[:110]}", DIM))

    if res.get("trace_url"):
        print()
        print(c(f"  trace  {res['trace_url']}", DIM))


def _wrap(text: str, width: int) -> list[str]:
    out: list[str] = []
    for para in str(text).splitlines() or [""]:
        line = ""
        for word in para.split():
            if len(line) + len(word) + 1 > width:
                out.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        out.append(line)
    return out


# --------------------------------------------------------------------------
# Session — the in-memory stand-in for Postgres
# --------------------------------------------------------------------------


@dataclass
class Session:
    """Everything the TUI needs to demonstrate replanning without a database."""

    today: str = field(default_factory=today_utc)
    availability: dict = field(
        default_factory=lambda: {"mon": 2, "tue": 2, "wed": 2, "thu": 2, "fri": 2, "sat": 0, "sun": 0}
    )
    blocked_dates: list[str] = field(default_factory=list)
    weekly_budget_hours: float = 10.0
    capacity_hours: float = 40.0
    active_goal_weekly_hours: list[float] = field(default_factory=list)

    goal_id: str = "goal-1"
    goal_title: str | None = None
    thread_id: str | None = None
    baseline: st.Baseline | None = None
    changes: list[st.Change] = field(default_factory=list)
    deltas: list[dict] = field(default_factory=list)
    last: dict = field(default_factory=dict)
    tasks: list[dict] = field(default_factory=list)
    #: Questions still awaiting an answer. While this is non-empty, a bare line
    #: at the prompt is an ANSWER, not a new message — otherwise the user types
    #: "16+" and the agent re-plans and asks the same question forever.
    pending: list[dict] = field(default_factory=list)
    answers: list[dict] = field(default_factory=list)

    def run_kw(self) -> dict:
        return dict(
            today=self.today,
            availability=self.availability,
            blocked_dates=self.blocked_dates,
            weekly_budget_hours=self.weekly_budget_hours,
            capacity_hours=self.capacity_hours,
            active_goal_weekly_hours=self.active_goal_weekly_hours,
            existing_goal_titles=[self.goal_title] if self.goal_title else [],
            goal_id=self.goal_id,
        )


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------


async def cmd_plan(sess: Session, message: str) -> None:
    head("planning")
    print(f"  {c('you:', DIM)} {message}")
    sess.pending, sess.answers = [], []  # a new message abandons any old question
    res = await run_plan(message=message, complete=get_complete(), **sess.run_kw())
    sess.thread_id = res.get("thread_id") or sess.thread_id
    sess.last = res
    render_result(res, tasks=sess.tasks)

    if res.get("kind") == "clarify":
        # Arm the prompt: the next bare line answers this, it does not re-plan.
        sess.pending = list(res.get("questions") or [])
        return

    if res.get("kind") == "ok":
        sess.goal_title = (res.get("plan_items") or [{}])[0].get("title") or sess.goal_title
        sess.tasks = _tasks_from_state(sess, res)
        # A confirmed plan write advances the generation — the count resets.
        sess.baseline = st.next_baseline(sess.baseline, goal_id=sess.goal_id)
        print()
        kv("plan confirmed", f"generation {sess.baseline.generation} · staleness now 0")


async def cmd_clarify(sess: Session, answers: list[dict]) -> None:
    head("resuming with answers")
    for a in answers:
        print(f"  {c(a.get('id') + ':', DIM)} {a.get('answer')}")
    res = await run_plan(
        message="",
        complete=get_complete(),
        thread_id=sess.thread_id,
        resume=answers,
        **sess.run_kw(),
    )
    sess.last = res
    render_result(res, tasks=sess.tasks)

    if res.get("kind") == "clarify":
        # A second round of questions — re-arm, do not treat as a fresh plan.
        sess.pending = list(res.get("questions") or [])
        sess.answers = []
        return

    if res.get("kind") == "ok":
        sess.goal_title = (res.get("plan_items") or [{}])[0].get("title") or sess.goal_title
        sess.tasks = _tasks_from_state(sess, res)
        sess.baseline = st.next_baseline(sess.baseline, goal_id=sess.goal_id)
        print()
        kv("plan confirmed", f"generation {sess.baseline.generation} · staleness now 0")


def take_answer(sess: Session, raw: str) -> None:
    """Record one answer against the first open question.

    A bare number selects that option; anything else is taken literally, so the
    user is never forced into the options the model guessed.
    """
    if not sess.pending:
        return
    q = sess.pending.pop(0)
    options = q.get("options") or []
    value = raw.strip()
    if value.isdigit() and 1 <= int(value) <= len(options):
        value = options[int(value) - 1]
    sess.answers.append({"id": q.get("id", "q"), "answer": value})


def prompt_hint(sess: Session) -> str:
    """What the `›` prompt is currently asking for."""
    if not sess.pending:
        return "› "
    q = sess.pending[0]
    return f"› [{q.get('id')}] "


def _tasks_from_state(sess: Session, res: dict) -> list[dict]:
    """Rebuild the task list from the run so the placement table has titles."""
    place = res.get("place") or {}
    slots = place.get("slots") or []
    if not slots:
        return sess.tasks
    # titles come from the daily rows' notes when available, else the id
    notes = {
        i.get("title"): i
        for i in (res.get("plan_items") or [])
        if i.get("horizon") == "daily"
    }
    out = []
    for s in slots:
        title = s["task_id"]
        for t, row in notes.items():
            if t and t in (row.get("note") or ""):
                title = t
                break
        out.append({"id": s["task_id"], "title": title})
    return out


async def cmd_replan(sess: Session, action: str) -> None:
    """Report a change and show which tier it lands in."""
    head(f"change reported: {action}")
    horizons, milestone_moved, label = _blast_radius(action)
    verdict = st.classify_change(horizons, milestone_moved=milestone_moved)

    change = st.make_change(
        sess.goal_id,
        action,
        horizons,
        milestone_moved=milestone_moved,
        detail={"label": label},
        generation=sess.baseline.generation if sess.baseline else 0,
    )
    sess.changes.append(change)

    kv("blast radius", ", ".join(horizons) or "none")
    kv("tier", c(verdict.tier.upper(), YELLOW if verdict.tier == "escalate" else GREEN))
    kv("reason", verdict.reason)

    if verdict.tier == "slim":
        print()
        print(c("  → slim: the solver re-places day-level dates silently.", DIM))
        await _resolve(sess)
        roll = st.rollup_counts(sess.changes, {sess.goal_id: sess.baseline} if sess.baseline else {})
        print()
        print(c("  toaster:", CYAN))
        for a in st.build_adjustments([c for c in sess.changes if c.generation == (sess.baseline.generation if sess.baseline else 0)]):
            print(f"    • {a}")
        kv("refresh button", roll["label"])
    else:
        print()
        print(c("  → escalate: minimal day-level changes apply now; the rest waits", DIM))
        print(c("     for the confirm modal. Rejecting it still leaves the refresh button.", DIM))
        roll = st.rollup_counts(sess.changes, {sess.goal_id: sess.baseline} if sess.baseline else {})
        kv("refresh button", roll["label"])


def _blast_radius(action: str) -> tuple[list[str], bool, str]:
    """What a given write actually moves. In the real system the route supplies
    this; here it is a table so the TUI can exercise every tier."""
    table = {
        "daily_log": (["daily"], False, "today's log"),
        "blocker.add": (["daily"], False, "your Goa trip"),
        "plan_item.edit": (["daily"], False, "your manual edit"),
        "goal.edit": (["weekly", "daily"], False, "the goal's scope"),
        "goal.dates": (["monthly", "weekly", "daily"], True, "the new timeline"),
        "milestone.edit": (["monthly"], True, "the moved milestone"),
    }
    return table.get(action, (["daily"], False, action))


async def _resolve(sess: Session) -> None:
    """Re-run placement with the accumulated deltas — the slim replan."""
    if not sess.last.get("plan_items"):
        return
    res = await run_plan(
        message="re-plan with the accumulated constraint deltas",
        complete=stub_complete,
        deltas=sess.deltas,
        **sess.run_kw(),
    )
    sess.last = res
    if res.get("kind") == "ok":
        print()
        print(c("  re-placed:", CYAN))
        render_placement(res.get("place"), sess.tasks)


def cmd_staleness(sess: Session) -> None:
    head("staleness")
    baselines = {sess.goal_id: sess.baseline} if sess.baseline else {}
    roll = st.rollup_counts(sess.changes, baselines)
    kv("refresh button", roll["label"])
    kv("last planning", sess.baseline.last_planned_at if sess.baseline else "never")
    kv("generation", sess.baseline.generation if sess.baseline else 0)
    print()
    print(c("  toaster:", CYAN))
    for a in st.build_adjustments(sess.changes) or ["(nothing to adjust)"]:
        print(f"    • {a}")


def cmd_deltas(sess: Session) -> None:
    head("constraint deltas applied to the solver")
    if not sess.deltas:
        print(c("  (none — the review accepted the placement)", DIM))
        return
    for d in sess.deltas:
        kv(d["kind"], f"{d['task_id']} {d.get('other') or ''} {d.get('value') or ''}")


def cmd_rejects(sess: Session) -> None:
    head("rejection log (per-stage observability)")
    rejects = sess.last.get("rejects") or []
    if not rejects:
        print(c("  (no rejections — every stage recovered)", DIM))
        return
    for r in rejects:
        print(f"  {c(str(r.get('stage')).ljust(10), CYAN)} {str(r.get('reason'))[:120]}")


# --------------------------------------------------------------------------
# Demo — walks every functionality in one go
# --------------------------------------------------------------------------


def cmd_provider() -> None:
    head("provider")
    project = configure_tracing()
    kv("tracing", f"langsmith project {project!r}" if project else "off — set LANGSMITH_API_KEY to trace")
    cfg = resolve_provider()
    if cfg is None:
        kv("model", "stub (offline) — no API key configured")
        print()
        print(c("  to use a real model:", DIM))
        print(c("    export DEEPSEEK_API_KEY=sk-…", DIM))
        print(c("    export DEEPSEEK_API_URL=https://api.deepseek.com", DIM))
        print(c("    export DEEPSEEK_MODEL=deepseek-chat   # or your v4 model id", DIM))
        print(c("\n  then verify with:  .venv/bin/python -m app.llm.client --check", DIM))
        return
    kv("provider", cfg.name)
    kv("endpoint", cfg.endpoint)
    kv("model", cfg.model)
    kv("api key", f"{cfg.api_key[:6]}…{cfg.api_key[-4:]}")
    print()
    print(c("  verify with:  .venv/bin/python -m app.llm.client --check", DIM))


async def cmd_demo(sess: Session) -> None:
    print()
    print(c("  DEMO — every functionality, offline, deterministic.", BOLD))
    print(c("  (no API key configured, so the agent uses its stub model)", DIM))

    print()
    print(c("  [1/7] happy path: plan a goal", BOLD))
    await cmd_plan(sess, "I want to learn system design, 8 hours a week over 3 months")

    print()
    print(c("  [2/7] mandatory clarify: a material unknown", BOLD))
    await cmd_plan(sess, "I want to change my job")

    print()
    print(c("  [3/7] resume the paused thread with answers", BOLD))
    await cmd_clarify(sess, [{"id": "domain", "answer": "data engineering"}, {"id": "hours", "answer": "10"}])

    print()
    print(c("  [4/7] slim replan: a day-level change applies silently", BOLD))
    await cmd_replan(sess, "blocker.add")

    print()
    print(c("  [5/7] escalated replan: a milestone moves", BOLD))
    await cmd_replan(sess, "milestone.edit")

    print()
    print(c("  [6/7] staleness: the count and the toaster", BOLD))
    cmd_staleness(sess)

    print()
    print(c("  [7/7] over-commitment: renegotiation instead of a silent failure", BOLD))
    res = await run_plan(
        message="I want to learn system design, 20 hours a week over 3 months",
        complete=stub_complete,
        **{**sess.run_kw(), "capacity_hours": 20, "active_goal_weekly_hours": [8]},
    )
    render_result(res)

    print()
    print(rule())
    print(c("  demo complete.", BOLD))


# --------------------------------------------------------------------------
# REPL
# --------------------------------------------------------------------------


HELP = """
  Type a message to plan a goal, or use a command:

    /plan <message>     plan a goal  (same as typing a message)
    /answer             re-show the pending question
    /replan <action>    report a change — try: daily_log, blocker.add,
                        goal.edit, goal.dates, milestone.edit
    /staleness          refresh-button count + toaster strings
    /deltas             the constraint deltas currently applied
    /rejects            per-stage rejection log
    /demo               walk every functionality
    /help  /quit

  While a clarifying question is open, the prompt shows [question-id] and a
  bare line answers it — type a number to pick an option, or your own words.
"""


def show_question(q: dict) -> None:
    print(f"  {c('?', CYAN)} {q['question']}")
    for i, o in enumerate(q.get("options") or [], start=1):
        print(f"       {c(str(i), CYAN)}) {o}")


async def repl() -> None:
    sess = Session()
    provider = "stub (offline)" if get_complete() is stub_complete else "configured provider"

    print(rule("═"))
    print(c("  Sutra planning agent — terminal UI", BOLD))
    print(rule("═"))
    kv("model", provider)
    kv("today", sess.today)
    kv("availability", ", ".join(f"{k} {v}h" for k, v in sess.availability.items() if v))
    kv("weekly budget", f"{sess.weekly_budget_hours:g}h shared across goals")
    print(c("\n  /help for commands, /demo to walk everything, /quit to exit.", DIM))

    while True:
        try:
            raw = input(c(f"\n  {prompt_hint(sess)}", CYAN)).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not raw:
            continue

        cmd, _, rest = raw.partition(" ")
        try:
            if raw in ("/quit", "/exit", "/q"):
                return
            elif raw == "/help":
                print(HELP)
            elif raw == "/demo":
                await cmd_demo(sess)
            elif raw == "/staleness":
                cmd_staleness(sess)
            elif raw == "/deltas":
                cmd_deltas(sess)
            elif raw == "/rejects":
                cmd_rejects(sess)
            elif raw == "/provider":
                cmd_provider()
            elif raw == "/answer":
                if sess.pending:
                    show_question(sess.pending[0])
                else:
                    print(c("  nothing pending — plan something first", DIM))
            elif cmd == "/replan":
                if not rest.strip():
                    print(c("  usage: /replan <action>   e.g. /replan blocker.add", DIM))
                else:
                    await cmd_replan(sess, rest.strip())
            elif cmd == "/plan":
                if not rest.strip():
                    print(c("  usage: /plan <message>", DIM))
                else:
                    await cmd_plan(sess, rest.strip())
            elif raw.startswith("/"):
                print(c(f"  unknown command {raw!r} — /help", DIM))
            elif sess.pending:
                # A question is open, so a bare line is an ANSWER. This is the
                # fix for typing "16+" and being re-asked forever.
                take_answer(sess, raw)
                if sess.pending:
                    print()
                    show_question(sess.pending[0])
                else:
                    await cmd_clarify(sess, sess.answers)
            else:
                await cmd_plan(sess, raw)
        except Exception as exc:  # the TUI must survive anything the agent does
            print(c(f"  !! {type(exc).__name__}: {exc}", RED))


def main() -> None:
    try:
        asyncio.run(repl())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
