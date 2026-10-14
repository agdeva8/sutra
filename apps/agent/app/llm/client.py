"""The one LLM seam. Everything that talks to a model goes through here.

`complete` is injected, never imported by a node (HLD §15). That is what makes
the graph testable without a model — and it is why the TUI runs offline: with
no API key configured, `get_complete()` returns the deterministic stub, which
exercises every stage for real.

Provider config, in priority order:

    SUTRA_LLM_API_KEY / SUTRA_LLM_BASE_URL / SUTRA_LLM_MODEL   # explicit
    DEEPSEEK_API_KEY / DEEPSEEK_API_URL / DEEPSEEK_MODEL       # DeepSeek-native
    OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL            # OpenAI-native

Any of these makes the real provider active. DeepSeek and OpenAI are both
OpenAI-compatible chat-completions APIs, so one implementation covers both.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterator, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

#: (system, user, schema) -> validated model. Injected everywhere.
CompleteFn = Callable[[str, str, type[T]], Awaitable[T]]


class LlmError(RuntimeError):
    """Any failure reaching or parsing a model. Callers degrade, never raise."""


# --------------------------------------------------------------------------
# Tracing
#
# This provider speaks the OpenAI wire format over httpx, so LangGraph's own
# tracer cannot see the model calls — they would be invisible in LangSmith.
# These two helpers put them back on the trace, and cost nothing when tracing
# is off: `traceable` calls straight through, `_llm_run` yields a null context.
# --------------------------------------------------------------------------


def _traced(**kwargs: Any) -> Callable[[Any], Any]:
    """`@traceable` when LangSmith is installed, else an identity decorator."""
    try:
        from langsmith import traceable
    except ImportError:  # pragma: no cover - langsmith ships with langgraph

        def _identity(fn: Any) -> Any:
            return fn

        return _identity
    return traceable(**kwargs)


@contextmanager
def _llm_run(cfg: ProviderConfig, schema_name: str, system: str, user: str) -> Iterator[Any]:
    """One LangSmith LLM run per model call. A null context when tracing is off.

    The metadata is passed at creation, not stamped on afterwards: setting it
    via the ambient run tree silently drops it on the first call of a turn,
    which is exactly the call you most want to see. Here we always hold the
    config, so the provider and model are known up front.
    """
    from app.observability import tracing_enabled

    if not tracing_enabled():
        yield None
        return

    from langsmith.run_helpers import trace

    with trace(
        name="llm.model_call",
        run_type="llm",
        inputs={"system": system, "user": user},
        metadata={
            "ls_provider": cfg.name,
            "ls_model_name": cfg.model,
            "schema": schema_name,
        },
    ) as run:
        yield run


# --------------------------------------------------------------------------
# Provider selection
# --------------------------------------------------------------------------


@dataclass
class ProviderConfig:
    name: str
    api_key: str
    base_url: str
    model: str

    @property
    def endpoint(self) -> str:
        base = self.base_url.rstrip("/")
        # DeepSeek accepts /chat/completions with or without /v1; normalise so
        # both "https://api.deepseek.com" and ".../v1" work.
        return f"{base}/chat/completions"


def _first_env(*names: str) -> str:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    return ""


def resolve_provider() -> ProviderConfig | None:
    """The configured provider, or None when we should use the stub."""
    key = _first_env("SUTRA_LLM_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY")
    if not key:
        return None

    explicit = _first_env("SUTRA_LLM_BASE_URL")
    deepseek = _first_env("DEEPSEEK_API_URL", "DEEPSEEK_BASE_URL")
    openai = _first_env("OPENAI_BASE_URL")

    if explicit:
        name, base = "configured", explicit
    elif deepseek:
        name, base = "deepseek", deepseek
    elif openai:
        name, base = "openai", openai
    elif os.environ.get("DEEPSEEK_API_KEY"):
        name, base = "deepseek", "https://api.deepseek.com"
    else:
        name, base = "openai", "https://api.openai.com/v1"

    model = _first_env("SUTRA_LLM_MODEL", "DEEPSEEK_MODEL", "OPENAI_MODEL")
    if not model:
        model = "deepseek-chat" if name == "deepseek" else "gpt-4o-mini"

    return ProviderConfig(name=name, api_key=key, base_url=base, model=model)


def get_complete() -> CompleteFn:
    """Real provider when configured, deterministic stub otherwise.

    The stub is not a placeholder — it is how the TUI and the graph tests run
    with no network, and it exercises the same schemas the real model must fill.
    """
    return http_complete if resolve_provider() else stub_complete


#: Pydantic noise that only wastes tokens in a prompt. `additionalProperties`
#: is deliberately NOT here: for a `dict[str, X]` field it is the only thing
#: saying what X is, so dropping it leaves the model a bare `{"type":"object"}`.
_SCHEMA_NOISE = frozenset({"title", "description", "default"})

#: Nodes whose keys are DATA (field names, model names), not schema keywords.
#: Filtering inside these would delete a real field — `DecomposeStep.title` is
#: exactly that collision, and it silently vanished from the first brief.
_MAPS = frozenset({"properties", "$defs", "definitions"})


def schema_brief(schema: type[BaseModel]) -> str:
    """The real JSON schema, compacted, for injection into the system prompt.

    Without this the model invents its own field names — which is exactly what
    happened the first time this ran against DeepSeek: it returned
    `{"key": …, "reason": …}` for `material_unknowns` and added `confidence`,
    `can_plan`, `next_action`. The contract was right and the prompt was silent.
    """
    raw = schema.model_json_schema()
    return json.dumps(_compact(raw), separators=(",", ":"))


def _compact(node: Any, *, key: str = "") -> Any:
    if isinstance(node, dict):
        keep_all = key in _MAPS  # inside `properties`, every key is a field name
        return {
            k: _compact(v, key=k)
            for k, v in node.items()
            if (keep_all or k not in _SCHEMA_NOISE) and v not in ({}, [])
        }
    if isinstance(node, list):
        return [_compact(v, key=key) for v in node]
    return node


def _prompt_with_schema(system: str, schema: type[BaseModel]) -> str:
    return (
        f"{system}\n\n"
        f"Reply with exactly this JSON shape — these keys, no others, no nesting "
        f"beyond what is shown:\n{schema_brief(schema)}"
    )


@_traced(name="llm.complete", run_type="chain")
async def http_complete(system: str, user: str, schema: type[T]) -> T:
    """OpenAI-compatible JSON completion. Works for DeepSeek and OpenAI."""
    cfg = resolve_provider()
    if cfg is None:
        raise LlmError("no provider configured — set SUTRA_LLM_API_KEY or DEEPSEEK_API_KEY")

    system = _prompt_with_schema(system, schema)
    try:
        with _llm_run(cfg, schema.__name__, system, user):
            text = await _post(cfg, system, user)
        return _parse(text, schema)
    except LlmError as first:
        # One repair attempt. Real models get a schema wrong in a fixable way
        # (a missing required key, a string where a list was asked for) far more
        # often than they get it wrong unfixably, and the error message is the
        # most useful thing we can hand back.
        try:
            repair = (
                f"{user}\n\nYOUR PREVIOUS REPLY WAS REJECTED:\n{_brief(str(first), 600)}\n"
                f"Return the same JSON again with exactly that fixed."
            )
            with _llm_run(cfg, f"{schema.__name__}:repair", system, repair):
                text = await _post(cfg, system, repair)
            return _parse(text, schema)
        except LlmError:
            raise first from None


async def _post(cfg: ProviderConfig, system: str, user: str) -> str:
    import httpx

    payload: dict[str, Any] = {
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": 4096,
    }
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(
                cfg.endpoint,
                headers={
                    "Authorization": f"Bearer {cfg.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if r.status_code >= 400:
                # Surface the API's own message — a bare status code is useless
                # when the cause is "model not found" or "insufficient balance".
                raise LlmError(f"{cfg.name} HTTP {r.status_code}: {_brief(r.text)}")
            body = r.json()
    except LlmError:
        raise
    except Exception as exc:
        raise LlmError(f"{cfg.name} request failed: {type(exc).__name__}: {exc}") from exc

    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LlmError(f"{cfg.name} returned an unexpected shape: {_brief(str(body))}") from exc


def _brief(text: str, limit: int = 300) -> str:
    return " ".join(str(text).split())[:limit]


def _parse(text: str, schema: type[T]) -> T:
    """Parse a model response into `schema`, tolerating a fenced code block."""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    try:
        return schema.model_validate(json.loads(raw))
    except json.JSONDecodeError as exc:
        raise LlmError(
            f"model did not return JSON: {exc} — got: {_brief(raw)}"
        ) from exc
    except ValidationError as exc:
        raise LlmError(f"model output failed {schema.__name__}: {exc}") from exc


# --------------------------------------------------------------------------
# Self-test — run this before trusting the real provider
# --------------------------------------------------------------------------


async def check_provider() -> int:
    """`python -m app.llm.client --check`. Prints what is wrong, not just that
    something is. Returns a shell exit code."""
    cfg = resolve_provider()
    if cfg is None:
        print("no provider configured — the stub will be used.")
        print("set DEEPSEEK_API_KEY (and DEEPSEEK_API_URL) or SUTRA_LLM_API_KEY.")
        return 1

    print(f"provider  {cfg.name}")
    print(f"endpoint  {cfg.endpoint}")
    print(f"model     {cfg.model}")
    print(f"api key   {cfg.api_key[:6]}…{cfg.api_key[-4:]} ({len(cfg.api_key)} chars)")

    import httpx

    # 1. can we reach the host at all?
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                cfg.base_url.rstrip("/") + "/models",
                headers={"Authorization": f"Bearer {cfg.api_key}"},
            )
        if r.status_code < 400:
            try:
                ids = [m.get("id") for m in r.json().get("data", [])]
                print(f"\nmodels available ({len(ids)}): {', '.join(str(i) for i in ids[:12])}")
                if cfg.model not in ids:
                    print(f"  !! {cfg.model!r} is NOT in that list — set the model explicitly")
            except Exception:
                pass
        else:
            print(f"\n/models -> HTTP {r.status_code}: {_brief(r.text)}")
    except Exception as exc:
        print(f"\n!! cannot reach {cfg.base_url}: {type(exc).__name__}: {exc}")
        return 2

    # 2. can we get schema-valid structured output from EVERY stage? Intake
    #    passing tells you nothing about whether `PlanSpec` or `DecomposeSpec`
    #    will — and those are the ones the graph actually needs.
    from app import prompts
    from app.contracts import schemas as S

    cases = [
        (S.IntakeSpec, "I want to learn Rust"),
        (S.PlanSpec, "I want to learn Rust, 6 hours a week over 2 months"),
    ]
    failed = 0
    print()
    for schema, message in cases:
        try:
            out = await http_complete(prompts.BASE, f"User: {message}", schema)
            print(f"  ok    {schema.__name__:16} {_summarise(out)}")
        except LlmError as exc:
            failed += 1
            print(f"  FAIL  {schema.__name__:16} {_brief(str(exc), 400)}")
    return 3 if failed else 0


def _summarise(obj: BaseModel) -> str:
    from app.contracts import schemas as S

    if isinstance(obj, S.IntakeSpec):
        return f"intent={obj.intent!r} unknowns={obj.material_unknowns} q={len(obj.clarifying_questions)}"
    if isinstance(obj, S.PlanSpec):
        g = obj.goal
        return f"goal={g.title!r} horizon={g.horizon} ms={len(obj.milestones)}" if g else "no goal"
    return ""


def main(argv: list[str] | None = None) -> None:
    import asyncio
    import sys

    argv = argv if argv is not None else sys.argv[1:]
    if "--check" in argv or not argv:
        sys.exit(asyncio.run(check_provider()))
    print("usage: python -m app.llm.client --check")


if __name__ == "__main__":
    main()


# --------------------------------------------------------------------------
# Deterministic stub — offline, exercises every stage for real
# --------------------------------------------------------------------------


async def stub_complete(system: str, user: str, schema: type[T]) -> T:
    """A rule-based stand-in for the model. Deterministic, no network.

    It reads the user's words and produces schema-valid output, so the whole
    graph — including the clarify interrupt and the review loop — runs offline.
    """
    from app.contracts import schemas as S

    if schema is S.IntakeSpec:
        return _stub_intake(user)  # type: ignore[return-value]
    if schema is S.PlanSpec:
        return _stub_plan(user)  # type: ignore[return-value]
    if schema is S.DecomposeSpec:
        return _stub_decompose(user)  # type: ignore[return-value]
    if schema is S.PlacementCritique:
        return _stub_review(user)  # type: ignore[return-value]
    if schema is S.ReplanAction:
        return _stub_action(user)  # type: ignore[return-value]
    raise LlmError(f"stub has no handler for {schema.__name__}")


# --- keyword helpers -------------------------------------------------------

_ADD = re.compile(r"\b(i want to|i wanna|help me|plan|goal|switch|learn|build|start|get|become)\b", re.I)
_PLAN_DAY = re.compile(r"\b(today|tomorrow|my day|plan my day|schedule my day)\b", re.I)
_EDIT = re.compile(r"\b(edit|change|move|push|extend|shorten|update|reschedule)\b", re.I)
_DROP = re.compile(r"\b(drop|abandon|give up|quit|pause|stop)\b", re.I)
_REVIEW = re.compile(r"\b(how am i|review|progress|on track|behind|check in)\b", re.I)

#: A material unknown is present when a job/career goal names no target domain.
_JOB = re.compile(r"\b(job|role|career|interview|switch)\b", re.I)
_DOMAIN = re.compile(
    r"\b(software|swe|frontend|backend|data|ml|machine learning|product|design|"
    r"marketing|sales|finance|consulting|teaching|nursing|law|devops|sre|"
    r"android|ios|mobile|qa|security|pm|analyst|engineer|manager)\b",
    re.I,
)
_HOURS = re.compile(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b", re.I)
# The hours question's own options ("3–5", "11–15", "16+") carry no unit, so a
# card answer never matches `_HOURS`. Without this the stub re-asks the
# question it was just answered. Used only for "was hours already answered".
_HOURS_ANSWER = re.compile(r"\b\d+\s*[-–—]\s*\d+\b|\b\d+\s*\+")
_MONTHS = re.compile(r"\b(\d+)\s*(?:months?|mo)\b", re.I)
_WEEKS = re.compile(r"\b(\d+)\s*(?:weeks?|w)\b", re.I)


def _user_message(user: str) -> str:
    """Everything after the last `User:` marker — the stub only needs the request.

    The message is the final thing in every stage prompt and can span lines (a
    clarify card submits one line per answer), so this reads to the end rather
    than stopping at the first newline.
    """
    parts = re.split(r"^User:\s*", user, flags=re.M)
    return parts[-1].strip() if len(parts) > 1 else user.strip()


def _today(user: str) -> str:
    m = re.search(r"Today is (\d{4}-\d{2}-\d{2})", user)
    if m:
        return m.group(1)
    from app.core.util import today_utc

    return today_utc()


def _existing(user: str) -> list[str]:
    m = re.search(r"What the user already has:\s*(.+)$", user, re.M)
    if not m:
        return []
    raw = m.group(1).strip()
    if not raw or raw.lower() in ("none", "[]", "nothing"):
        return []
    return [t.strip() for t in re.split(r"[,;]", raw) if t.strip()]


# --- stage stubs -----------------------------------------------------------


def _stub_intake(user: str):
    from app.contracts import schemas as S

    msg = _user_message(user)
    existing = _existing(user)

    if _REVIEW.search(msg):
        intent = "review_progress"
    elif _PLAN_DAY.search(msg):
        intent = "plan_day"
    elif _DROP.search(msg):
        intent = "drop_goal"
    elif _EDIT.search(msg) and existing:
        intent = "edit_goal"
    elif _ADD.search(msg) or not existing:
        intent = "add_goal"
    else:
        intent = "replan"

    unknowns: list[str] = []
    questions: list[S.ClarifyQuestion] = []

    # The forcing rule: a job/career goal with no named domain is a material
    # unknown — v1 shipped the bug where it assumed software engineering.
    if intent in ("add_goal", "edit_goal") and _JOB.search(msg) and not _DOMAIN.search(msg):
        unknowns.append("target role or domain")
        questions.append(
            S.ClarifyQuestion(
                id="domain",
                question="Which role or domain are you targeting?",
                options=["software engineering", "data / ML", "product", "other"],
            )
        )
    if intent == "add_goal" and not (_HOURS.search(msg) or _HOURS_ANSWER.search(msg)):
        unknowns.append("hours available per week")
        questions.append(
            S.ClarifyQuestion(
                id="hours",
                question="Roughly how many hours a week can you give this?",
                options=["3–5", "6–10", "11–15", "16+"],
            )
        )

    article = "an" if intent[0] in "aeiou" else "a"
    return S.IntakeSpec(
        intent=intent,
        material_unknowns=unknowns,
        clarifying_questions=questions,
        referenced_goal_titles=existing[:3],
        framing_line=f"Planning {article} {intent.replace('_', ' ')}.",
    )


def _answers(user: str) -> dict[str, str]:
    """Read back the clarify answers the graph folded into the context."""
    out: dict[str, str] = {}
    block = re.search(r"ANSWERS ALREADY GIVEN:\n((?:- .+\n?)+)", user)
    if not block:
        return out
    for line in block.group(1).splitlines():
        m = re.match(r"-\s*([\w\-]+):\s*(.*)$", line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def _strip_answers_block(user: str) -> str:
    """Drop the folded `ANSWERS ALREADY GIVEN` block before parsing a prompt.

    The block is a run of `- ` lines, and so are the two prompt formats the
    stubs parse: `_weekly_rows` would turn `- domain: data engineering` into a
    phantom weekly row and then decompose the question the graph just asked, and
    `_placement_lines` would turn a date-valued answer into a phantom slot and
    invent a review rejection out of it. Both fail *quietly* — the plan still
    comes out looking tidy — which is why it is stripped here rather than worked
    around by moving `{context}` in the prompt. The order-dependent parsing is
    the bug, not the layout.
    """
    head, sep, _ = user.partition("\n\nANSWERS ALREADY GIVEN:\n")
    if sep:
        return head
    head, sep, _ = user.partition("ANSWERS ALREADY GIVEN:\n")
    return head if sep else user


def _hours_from(user: str) -> float | None:
    """Hours the user stated, from the message or from a clarify answer."""
    msg = _user_message(user)
    m = _HOURS.search(msg)
    if m:
        return float(m.group(1))
    ans = _answers(user).get("hours")
    if ans:
        m2 = re.search(r"(\d+(?:\.\d+)?)", ans)
        if m2:
            return float(m2.group(1))
    return None


def _stub_plan(user: str):
    from app.contracts import schemas as S
    from app.core.util import add_days

    msg = _user_message(user)
    today = _today(user)
    answers = _answers(user)

    title = _title_from(msg)
    # If the user named a domain when asked, the goal is about that domain.
    if answers.get("domain"):
        title = f"{title} ({answers['domain']})" if title != "New goal" else answers["domain"]

    horizon, days = _size_from(msg)
    weeks = max(1, days // 7)
    hours = _hours_from(user) or 8.0
    hours = max(1.0, min(20.0, hours))

    target = add_days(today, days)

    phases = ["Foundations", "Deliberate practice", "Full loops", "Active"]
    phases = phases[: max(2, min(4, weeks // 3 + 2))]

    slug = title.lower()
    milestones = [
        S.MilestoneSpec(title=f"Baseline {slug} assessment done", phase=phases[0]),
        S.MilestoneSpec(title=f"First full {slug} dry run", phase=phases[1]),
        S.MilestoneSpec(title=f"Five {slug} runs at target quality", phase=phases[-2]),
        S.MilestoneSpec(title=f"{title} complete", phase=phases[-1]),
    ]

    return S.PlanSpec(
        goal=S.GoalSpec(
            title=title,
            horizon=horizon,
            why=f"The user asked: {msg[:160]}",
            first_action=f"Block the first {max(1, int(hours / 3))}h session and do the baseline assessment",
            start_date=today,
            target_date=target,
            weekly_hours=hours,
            phase_objectives=phases,
        ),
        milestones=milestones,
        prose=(
            f"{days} days, {len(phases)} phases, 20% headroom held back. "
            f"The load-bearing constraint is the weekly {hours:g}h — if that slips, "
            f"the plan slips with it."
        ),
    )


def _stub_decompose(user: str):
    from app.contracts import schemas as S

    rows = _weekly_rows(user)
    steps: dict[str, list[S.DecomposeStep]] = {}
    for i, (title, hours) in enumerate(rows):
        per = max(1.0, round(hours / 3, 1))
        steps[title] = [
            S.DecomposeStep(
                title=f"Prepare for {title.lower()}",
                est_hours=per,
                priority=4,
                session_max_hours=min(2.0, per),
            ),
            S.DecomposeStep(
                title=f"Do the core work for {title.lower()}",
                est_hours=per,
                priority=5,
                depends_on=[f"Prepare for {title.lower()}"],
                session_max_hours=min(2.0, per),
            ),
            S.DecomposeStep(
                title=f"Review and log {title.lower()}",
                est_hours=max(1.0, round(per / 2, 1)),
                priority=2,
                depends_on=[f"Do the core work for {title.lower()}"],
            ),
        ]
    return S.DecomposeSpec(steps=steps)


def _stub_review(user: str):
    """Reject only on a *detectable* absurdity, so the loop is exercised but the
    happy path stays quiet.

    The detectable case: the plan's culminating step landed on the earliest day,
    which means the solver front-loaded a step whose dependency chain says it
    should be last.
    """
    from app.contracts import schemas as S

    placement = _placement_lines(user)
    if not placement:
        return S.PlacementCritique(ok=True, rationale="no placement to review")

    dates = {tid: d for tid, d in placement}
    early = min(dates.values())

    # a step whose title says it is a review/culminating step, placed first
    culprits = [
        tid
        for tid, d in placement
        if d == early and re.search(r"\b(review|final|complete|dry run)\b", tid, re.I)
    ]
    if culprits and len(placement) > 2:
        target = culprits[0]
        prereq = next((tid for tid, _ in placement if tid != target), None)
        deltas = [S.ConstraintDelta(kind="precedence", task_id=target, other=prereq)]
        return S.PlacementCritique(
            ok=False,
            deltas=deltas,
            rationale=(
                f"{target!r} is a culminating step but landed on the earliest day; "
                f"it must come after {prereq!r}."
            ),
        )
    return S.PlacementCritique(ok=True, rationale="placement reads sensibly")


def _stub_action(user: str):
    from app.contracts import schemas as S

    msg = _user_message(user)
    goal = None
    m = re.search(r"Goal:\s*(.+)$", user, re.M)
    if m:
        goal = m.group(1).strip()

    hours = _HOURS.search(msg)
    changes = S.PlanChanges(
        title=goal,
        weekly_hours=float(hours.group(1)) if hours else None,
    )
    return S.ReplanAction(
        intent="add_goal" if goal else "edit_goal",
        goal_id=None,
        changes=changes,
        rationale=f"Applied the user's request: {msg[:120]}",
    )


# --- stub parsing helpers --------------------------------------------------


def _title_from(msg: str) -> str:
    """A short goal title — the verb's object, minus the qualifier clauses.

    "I want to learn system design, 8 hours a week over 3 months" must yield
    "System design", not the whole sentence.
    """
    m = re.search(
        r"(?:switch|change|become|learn|build|start|get)\s+(?:to\s+|a\s+|an\s+)?(.{3,60})",
        msg,
        re.I,
    )
    if not m:
        return "New goal"

    t = m.group(1).strip(" .!?,")
    # drop the qualifier clauses: "… , 8 hours a week over 3 months"
    t = re.split(r"[,;]", t)[0]
    t = re.split(r"\b(?:in|within|by|over|next|for)\b", t, flags=re.I)[0]
    t = re.sub(r"\b\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours|months?|weeks?)\b.*$", "", t, flags=re.I)
    t = t.strip(" .,-")
    return (t[:1].upper() + t[1:]) if t else "New goal"


def _size_from(msg: str) -> tuple[str, int]:
    mo = _MONTHS.search(msg)
    if mo:
        days = int(float(mo.group(1)) * 30)
    else:
        wk = _WEEKS.search(msg)
        days = int(float(wk.group(1)) * 7) if wk else 90
    if days <= 14:
        return "weekly", max(7, days)
    if days <= 90:
        return "short", days
    if days <= 270:
        return "medium", days
    return "long", days


def _weekly_rows(user: str) -> list[tuple[str, float]]:
    """Read the weekly rows out of the decompose prompt."""
    out: list[tuple[str, float]] = []
    for line in _strip_answers_block(user).splitlines():
        m = re.match(r"\s*[-*]\s*(.+?)\s*(?:\|\s*([\d.]+)\s*h)?\s*$", line)
        if m and m.group(1) and not m.group(1).lower().startswith(("availability", "weekly rows")):
            title = m.group(1).strip()
            hours = float(m.group(2)) if m.group(2) else 2.0
            if title and title not in {t for t, _ in out}:
                out.append((title, hours))
    return out[:12]


def _placement_lines(user: str) -> list[tuple[str, str]]:
    """Read `task_id  date` pairs out of the review prompt."""
    out: list[tuple[str, str]] = []
    for line in _strip_answers_block(user).splitlines():
        m = re.match(r"\s*[-*]?\s*([\w\-]+)\s+(\d{4}-\d{2}-\d{2})\b", line)
        if m:
            out.append((m.group(1), m.group(2)))
    return out
