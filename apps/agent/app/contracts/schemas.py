"""Every contract, in one place — the single source of truth for every shape.

Two bases, because two different things are being validated:

* `_Strict` — `extra="forbid"`. For models WE construct and for the solver's
  I/O. An unexpected key here is a bug in our own code.
* `_Llm` — `extra="ignore"`. For models the MODEL fills. A real model
  volunteers fields it was never asked for; rejecting the whole response over
  an unrequested extra is a reliability bug, not rigour. It bit us on the first
  real DeepSeek run: 23 validation errors, and the agent could not plan at all.

Two rules this module enforces in code rather than in prose:

1. **The LLM never supplies a date for a task.** `_Llm` subclasses that must
   never carry one set `_no_dates = True`, which rejects a date-shaped *key*
   rather than the whole object — tolerant of invention, intolerant of the one
   thing that would break the single-writer invariant. (HLD §3.)
2. **The solver's verdict is computed, never asserted.** `PlaceResult.feasible`
   comes from the solver; `PlacementCritique.ok` is the only LLM judgment call,
   and when it is `False` it must carry constraint deltas. (HLD §8.6.)
"""
from __future__ import annotations

from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# --------------------------------------------------------------------------
# Vocabularies — two that v1 conflated and must stay distinct (HLD §7)
# --------------------------------------------------------------------------

#: Sizes a GOAL. `short` = 30–90 days.
GoalSize = Literal["weekly", "short", "medium", "long"]

#: The `plan_items.horizon` grain — the execution ladder.
PlanHorizon = Literal["daily", "weekly", "monthly", "quarterly", "yearly"]

#: What the user asked for.
Intent = Literal[
    "add_goal",
    "plan_day",
    "edit_goal",
    "drop_goal",
    "review_progress",
    "replan",
]

#: Ask / auto / grill — how freely intake may ask.
Mode = Literal["auto", "ask", "grill"]

#: Replan tier (HLD §9.2). `slim` applies silently, `escalate` needs the modal.
Tier = Literal["slim", "escalate"]

#: The shape of a change's blast radius. Every kind is expressible as a CP-SAT
#: constraint under the one-sitting-per-task model — which is the test for
#: whether a kind belongs here at all.
DeltaKind = Literal[
    "precedence",     # task A must land before task B
    "allowed_days",   # restrict a task to certain weekdays (0=Mon..6=Sun)
    "avoid_week",     # keep a task out of an ISO week
    "max_per_day",    # at most N sittings on any one day
    "session_max",    # cap the hours in a single sitting
    "pin",            # force a task onto a date
    "priority_bump",  # raise a task's weight in the objective
]

#: Terminal kinds of a pipeline run.
ResultKind = Literal["ok", "early", "no_change", "renegotiate", "clarify"]

HORIZON_WINDOWS: dict[str, tuple[int, int]] = {
    "weekly": (7, 14),
    "short": (30, 90),
    "medium": (90, 270),
    "long": (270, 540),
}

PLAN_HORIZONS: tuple[PlanHorizon, ...] = (
    "yearly",
    "quarterly",
    "monthly",
    "weekly",
    "daily",
)

#: The execution ladder, coarsest first — used for blast-radius ranking.
HORIZON_RANK: dict[str, int] = {
    "daily": 0,
    "weekly": 1,
    "monthly": 2,
    "quarterly": 3,
    "yearly": 4,
}


class _Strict(BaseModel):
    """Base for INTERNAL models: unknown keys are an error, not a shrug."""

    model_config = ConfigDict(extra="forbid")


#: Key names that mean "this is a date". Used to keep the HLD §3 guarantee
#: ("the LLM never supplies a date for a task") while still tolerating the
#: incidental extra fields a real model likes to volunteer.
_DATE_KEYS = frozenset(
    {
        "date",
        "dates",
        "day",
        "days",
        "when",
        "start_date",
        "end_date",
        "due_date",
        "target_date",
        "scheduled_date",
        "scheduled_for",
        "deadline",
    }
)


class _Llm(BaseModel):
    """Base for models the LLM fills.

    `extra="ignore"` rather than `forbid`: a real model volunteers fields it was
    never asked for (`confidence`, `reason`, `next_action`), and rejecting the
    whole response over an unrequested extra is a reliability bug, not rigour.

    The one thing still rejected is a DATE. Subclasses that must never carry one
    set `_no_dates = True`, so the guarantee is enforced on the *key* rather than
    on the whole object — tolerant of invention, intolerant of the one thing
    that would break the single-writer invariant (HLD §3).
    """

    model_config = ConfigDict(extra="ignore")

    #: When True, any date-shaped key in the input is a validation error.
    _no_dates: ClassVar[bool] = False

    @model_validator(mode="before")
    @classmethod
    def _reject_date_keys(cls, data: Any) -> Any:
        if not cls._no_dates or not isinstance(data, dict):
            return data
        bad = sorted(k for k in data if k in _DATE_KEYS)
        if bad:
            raise ValueError(
                f"dates belong to the solver, not the model — remove {bad}"
            )
        return data


# --------------------------------------------------------------------------
# Solver I/O
# --------------------------------------------------------------------------


class HorizonTask(_Strict):
    """One work item to place. **No date field** — placement owns dates."""

    id: str
    title: str
    phase: str = ""
    window_start: str  # ISO YYYY-MM-DD
    window_end: str
    est_hours: float = Field(gt=0, le=40)
    priority: int = Field(default=3, ge=1, le=5)
    order: int = 0
    goal_id: str = ""
    goal_priority: int = Field(default=3, ge=1, le=5)
    depends_on: list[str] = Field(default_factory=list)
    session_max_hours: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _window_ordered(self) -> HorizonTask:
        if self.window_end < self.window_start:
            raise ValueError(
                f"task {self.id}: window_end {self.window_end} precedes "
                f"window_start {self.window_start}"
            )
        return self


class Slot(_Strict):
    """A placed task: which day, and how many hours in that sitting."""

    task_id: str
    date: str
    hours: float = Field(gt=0)


class PlaceResult(_Strict):
    feasible: bool
    slots: list[Slot] = Field(default_factory=list)
    #: Tasks that got NO hours at all — kept at their window start.
    unscheduled: list[str] = Field(default_factory=list)
    #: Tasks that got some hours but fewer than their estimate.
    short: list[str] = Field(default_factory=list)
    #: "cpsat" | "structural" — which engine actually produced this.
    solver: str = "cpsat"
    detail: str = ""

    def by_task(self) -> dict[str, Slot]:
        return {s.task_id: s for s in self.slots}

    def hours_by_task(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for s in self.slots:
            out[s.task_id] = round(out.get(s.task_id, 0.0) + s.hours, 1)
        return out


class Availability(BaseModel):
    """Weekly capacity. `hours` is per weekday name; `blocked` removes days."""

    model_config = ConfigDict(extra="forbid")

    hours: dict[str, float] = Field(default_factory=dict)
    blocked_dates: list[str] = Field(default_factory=list)
    weekly_budget_hours: float | None = Field(default=None, gt=0)

    def cap_for(self, date: str) -> float:
        if date in set(self.blocked_dates):
            return 0.0
        return max(0.0, float(self.hours.get(_weekday_name(date), 0.0)))


def _weekday_name(iso: str) -> str:
    import datetime as _dt

    d = _dt.date.fromisoformat(iso)
    return ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[d.weekday()]


# --------------------------------------------------------------------------
# Persistence contract — the schedule of record
# --------------------------------------------------------------------------


class PlanItemRow(_Strict):
    """One row of `plan_items`. The solver is the only writer of the dates."""

    horizon: PlanHorizon
    phase: str = ""
    title: str
    note: str = ""
    start_date: str | None = None
    end_date: str | None = None
    due_date: str | None = None
    weekly_hours: float | None = None
    status: str = "pending"


# --------------------------------------------------------------------------
# LLM stage outputs — meaning only, never dates
# --------------------------------------------------------------------------


class MilestoneSpec(_Llm):
    """A milestone is an OUTCOME checkpoint — an overlay chip, not a plan level.

    `target_date` is deliberately absent: the lattice derives it (HLD §8.1).
    """

    _no_dates: ClassVar[bool] = True

    title: str
    phase: str = ""
    rationale: str = ""


class GoalSpec(_Llm):
    title: str
    horizon: GoalSize
    why: str = ""
    first_action: str = ""
    start_date: str
    target_date: str
    weekly_hours: float = Field(gt=0, le=40)
    phase_objectives: list[str] = Field(default_factory=list)

    @field_validator("phase_objectives", mode="before")
    @classmethod
    def _phases_named(cls, v: Any) -> list[str]:
        """Phases are a trajectory, so 2–4 is the intent — but a model that
        returns three where it meant two should not fail the whole turn. Blank
        phases are dropped; the count is clamped rather than rejected."""
        if not isinstance(v, list):
            return []
        out = [str(p).strip() for p in v if str(p).strip()]
        return out[:4]


class PlanSpec(_Llm):
    """Stage `n_plan` output — goal + milestones. No dates on milestones."""

    goal: GoalSpec | None = None
    milestones: list[MilestoneSpec] = Field(default_factory=list)
    prose: str = ""


class DecomposeStep(_Llm):
    """One weekly step. Effort and dependencies only — **no date field**."""

    _no_dates: ClassVar[bool] = True

    title: str
    est_hours: float = Field(gt=0, le=40)
    priority: int = Field(default=3, ge=1, le=5)
    depends_on: list[str] = Field(default_factory=list)
    session_max_hours: float | None = Field(default=None, gt=0)


class DecomposeSpec(_Llm):
    """Keyed by the weekly row's title; each value is that week's steps."""

    steps: dict[str, list[DecomposeStep]] = Field(default_factory=dict)

    @model_validator(mode="before")
    @classmethod
    def _accept_a_bare_list_per_row(cls, data: Any) -> Any:
        """A model may key straight to a list rather than to `{"steps": [...]}`."""
        if not isinstance(data, dict):
            return data
        raw = data.get("steps")
        if isinstance(raw, dict):
            data = {**data, "steps": {k: _as_step_list(v) for k, v in raw.items()}}
        return data


def _as_step_list(v: Any) -> Any:
    if isinstance(v, dict) and "steps" in v:
        return v["steps"]
    return v


class ClarifyQuestion(_Llm):
    """One question for the user. `id` is OPTIONAL — the model has no reason to
    invent a stable key, and the graph keys answers positionally anyway."""

    id: str = ""
    question: str
    options: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _ensure_id(self) -> ClarifyQuestion:
        if not self.id:
            self.id = f"q{abs(hash(self.question)) % 10**6}"
        return self

    @field_validator("options", mode="before")
    @classmethod
    def _options_are_strings(cls, v: Any) -> Any:
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for o in v:
            if isinstance(o, str):
                out.append(o)
            elif isinstance(o, dict):
                # {"label": "…"} / {"value": "…"} — take the first string-ish value
                for key in ("label", "value", "text", "option", "title"):
                    if isinstance(o.get(key), str):
                        out.append(o[key])
                        break
        return out


class IntakeSpec(_Llm):
    intent: Intent
    material_unknowns: list[str] = Field(default_factory=list)
    clarifying_questions: list[ClarifyQuestion] = Field(default_factory=list)
    referenced_goal_titles: list[str] = Field(default_factory=list)
    framing_line: str = ""

    @field_validator("material_unknowns", mode="before")
    @classmethod
    def _unknowns_are_strings(cls, v: Any) -> Any:
        """A model returns `{"key": …, "reason": …}`; downstream wants a name."""
        if not isinstance(v, list):
            return []
        out: list[str] = []
        for u in v:
            if isinstance(u, str):
                out.append(u)
            elif isinstance(u, dict):
                for key in ("key", "name", "unknown", "field", "what"):
                    if isinstance(u.get(key), str):
                        out.append(u[key])
                        break
                else:
                    if isinstance(u.get("reason"), str):
                        out.append(u["reason"])
        return out

    @model_validator(mode="after")
    def _material_unknown_forces_a_question(self) -> IntakeSpec:
        """HLD §10: a material unknown makes the clarify interrupt MANDATORY.

        Enforced here rather than trusted to the prompt, so the model cannot
        forget to ask. A model that lists an unknown and forgets the question is
        completed rather than rejected — the invariant is "we must ask", and
        synthesising the question satisfies it more usefully than failing the
        whole turn.
        """
        if self.material_unknowns and not self.clarifying_questions:
            self.clarifying_questions = [
                ClarifyQuestion(
                    id=f"u{i}",
                    question=f"What is the {u}?",
                )
                for i, u in enumerate(self.material_unknowns, start=1)
            ]
        return self


# --------------------------------------------------------------------------
# Proposals — one action, intent-discriminated (HLD §7)
# --------------------------------------------------------------------------


class PlanChanges(_Llm):
    """The SEMANTIC delta. Task dates are absent by construction."""

    title: str | None = None
    target_date: str | None = None
    weekly_hours: float | None = Field(default=None, gt=0, le=40)
    milestones: list[MilestoneSpec] = Field(default_factory=list)
    phase_objectives: list[str] = Field(default_factory=list)


class ReplanAction(_Llm):
    """The ONE tool action, replacing v1's nine."""

    intent: Intent
    goal_id: str | None = None
    changes: PlanChanges = Field(default_factory=PlanChanges)
    rationale: str = ""


# --------------------------------------------------------------------------
# Placement review — the determinism trap (HLD §8.6)
# --------------------------------------------------------------------------


class ConstraintDelta(_Llm):
    """A structural correction to the solver's input.

    Every kind is expressible as a CP-SAT constraint, which is what keeps the
    LLM out of date-writing: it adjusts constraints, the solver re-solves.
    """

    kind: DeltaKind
    task_id: str
    other: str | None = None
    value: str | int | list[int] | None = None

    @field_validator("task_id", "other", mode="before")
    @classmethod
    def _ids_are_strings(cls, v: Any) -> Any:
        return None if v is None else str(v)

    @model_validator(mode="after")
    def _value_matches_kind(self) -> ConstraintDelta:
        needs_value = {
            "allowed_days",
            "avoid_week",
            "max_per_day",
            "session_max",
            "pin",
            "priority_bump",
        }
        if self.kind in needs_value and self.value is None:
            raise ValueError(f"delta kind {self.kind!r} requires a value")
        if self.kind == "precedence" and not self.other:
            raise ValueError("precedence requires `other` (the task to precede)")
        return self


class PlacementCritique(_Llm):
    """`n_review` output. On rejection, deltas are mandatory.

    Without them the loop cannot converge: CP-SAT is deterministic, so
    re-running `place` on unchanged input returns the identical plan.

    A bare rejection from a real model is coerced to `ok=True` rather than
    rejected: the deltas are the only thing that can change the answer, so a
    rejection without them is *not a rejection* — it is noise. Recording it and
    proceeding beats failing the turn over a judgment the model could not
    express structurally.
    """

    ok: bool
    deltas: list[ConstraintDelta] = Field(default_factory=list)
    rationale: str = ""

    @model_validator(mode="after")
    def _rejection_carries_deltas(self) -> PlacementCritique:
        if not self.ok and not self.deltas:
            self.ok = True
            self.rationale = (
                f"{self.rationale} (no constraint deltas given, so the rejection "
                f"could not change the solver's answer — treated as ok)"
            ).strip()
        return self


# --------------------------------------------------------------------------
# Replan bookkeeping
# --------------------------------------------------------------------------


class Change(_Strict):
    """One recorded change, against the goal's plan generation."""

    goal_id: str
    kind: str
    horizons_moved: list[PlanHorizon] = Field(default_factory=list)
    milestone_moved: bool = False
    detail: dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""
    generation: int = 0


class Verdict(_Strict):
    """Blast radius → tier. Computed in code, never by the LLM."""

    tier: Tier
    top_horizon: PlanHorizon | None = None
    reason: str = ""


# --------------------------------------------------------------------------
# Pipeline result
# --------------------------------------------------------------------------


class PipelineResult(_Strict):
    kind: ResultKind
    prose: str = ""
    proposals: list[ReplanAction] = Field(default_factory=list)
    plan_items: list[PlanItemRow] = Field(default_factory=list)
    questions: list[ClarifyQuestion] = Field(default_factory=list)
    adjustments: list[str] = Field(default_factory=list)
    tier: Tier | None = None
    reason: str = ""
    rejects: list[dict[str, Any]] = Field(default_factory=list)
    thread_id: str = ""
    place: PlaceResult | None = None
    review_rounds: int = 0
