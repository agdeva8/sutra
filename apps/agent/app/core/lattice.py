"""`build_lattice` — deterministic structure. PURE.

Owns phase spans, milestone dates, week bands, and the 20% buffer. Owns **no**
placement: which *day* a step lands on is `place`'s job (HLD §8.1 vs §8.2).

The 20% buffer is the whole point of the lattice: every span schedules into its
first 80%, so the tail absorbs slips before they propagate up a horizon.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.contracts.schemas import GoalSpec, MilestoneSpec, PlanItemRow
from app.core.util import add_days, days_between, iter_dates, round_half_up

#: Fraction of each span that is scheduled into; the rest absorbs slips.
BUFFER_RATIO = 0.2

#: A goal shorter than this is widened — a plan under a week has no structure.
MIN_TOTAL_DAYS = 7


@dataclass
class Span:
    phase: str
    start: str
    end: str

    @property
    def length(self) -> int:
        return days_between(self.start, self.end)

    @property
    def window_end(self) -> str:
        """The effective (80%) end — where scheduling actually stops."""
        return add_days(self.start, round_half_up((1 - BUFFER_RATIO) * self.length))


@dataclass
class LatticeMilestone:
    title: str
    phase: str
    target_date: str
    work_start: str
    rationale: str = ""


@dataclass
class LatticeResult:
    items: list[PlanItemRow] = field(default_factory=list)
    milestones: list[LatticeMilestone] = field(default_factory=list)
    spans: list[Span] = field(default_factory=list)
    #: Non-fatal: set when the lattice could not be built and the caller should
    #: continue with whatever it already had (HLD §13).
    error: str = ""


def build_lattice(
    *,
    goal: GoalSpec,
    milestones: list[MilestoneSpec],
    today: str,
) -> LatticeResult:
    """Lay structure for one goal. Deterministic: same input ⇒ same output."""
    try:
        return _build(goal=goal, milestones=milestones, today=today)
    except Exception as exc:  # non-fatal by contract — the caller carries on
        return LatticeResult(error=f"{type(exc).__name__}: {exc}")


def _build(*, goal: GoalSpec, milestones: list[MilestoneSpec], today: str) -> LatticeResult:
    start = goal.start_date
    target = goal.target_date
    total = days_between(start, target)
    if total < MIN_TOTAL_DAYS:
        target = add_days(start, MIN_TOTAL_DAYS)
        total = MIN_TOTAL_DAYS

    phases = list(goal.phase_objectives) or ["Plan"]
    spans = _spans(phases, start, total)

    # Milestones are distributed across spans by their `phase` label; a milestone
    # whose phase is unknown falls into the span whose name it matches, else the
    # first span that still has room.
    placed_ms = _place_milestones(milestones, spans)

    items: list[PlanItemRow] = []

    # --- yearly: the whole goal, one row -----------------------------------
    items.append(
        PlanItemRow(
            horizon="yearly",
            phase="Goal",
            title=goal.title,
            note=goal.why,
            start_date=start,
            end_date=target,
            weekly_hours=goal.weekly_hours,
        )
    )

    # --- quarterly: one row per span ---------------------------------------
    for span in spans:
        items.append(
            PlanItemRow(
                horizon="quarterly",
                phase=span.phase,
                title=span.phase,
                note=f"{span.start} → {span.end}",
                start_date=span.start,
                end_date=span.end,
                weekly_hours=goal.weekly_hours,
            )
        )

    # --- monthly (milestones) + weekly bands + daily rows ------------------
    for span in spans:
        in_span = [m for m in placed_ms if m.phase == span.phase]

        for m in in_span:
            items.append(
                PlanItemRow(
                    horizon="monthly",
                    phase=span.phase,
                    title=m.title,
                    note=m.rationale,
                    due_date=m.target_date,
                    start_date=m.work_start,
                )
            )

        for band_start, band_end, label, active_count in _bands(span, in_span):
            items.append(
                PlanItemRow(
                    horizon="weekly",
                    phase=span.phase,
                    title=label,
                    note=f"{band_start} → {band_end}",
                    start_date=band_start,
                    end_date=band_end,
                    weekly_hours=_band_hours(goal.weekly_hours, active_count),
                )
            )
            for day in iter_dates(band_start, band_end):
                items.append(
                    PlanItemRow(
                        horizon="daily",
                        phase=span.phase,
                        title=label,
                        note=f"Fulfils {label}",
                        start_date=day,
                        end_date=day,
                        weekly_hours=_per_day_hours(goal.weekly_hours, band_start, band_end, active_count),
                    )
                )

    return LatticeResult(items=items, milestones=placed_ms, spans=spans)


def _spans(phases: list[str], start: str, total: int) -> list[Span]:
    n = max(1, len(phases))
    out: list[Span] = []
    for i, phase in enumerate(phases or ["Plan"]):
        s = add_days(start, round_half_up(i * total / n))
        e = add_days(start, round_half_up((i + 1) * total / n))
        if e <= s:  # a degenerate span would make window_end useless
            e = add_days(s, 1)
        out.append(Span(phase=phase, start=s, end=e))
    return out


def _place_milestones(
    milestones: list[MilestoneSpec], spans: list[Span]
) -> list[LatticeMilestone]:
    """Spread each span's milestones evenly, with parallel work tracks.

    `target` is the commitment date; `work_start` is when work toward it begins
    (half the inter-milestone gap), which is what lets two milestones overlap
    without both being due at once.
    """
    by_phase: dict[str, list[MilestoneSpec]] = {s.phase: [] for s in spans}
    leftovers: list[MilestoneSpec] = []
    for m in milestones:
        (by_phase[m.phase] if m.phase in by_phase else leftovers).append(m)

    # Unknown phases go to the first span, in order, so nothing is lost.
    if leftovers and spans:
        by_phase[spans[0].phase].extend(leftovers)

    out: list[LatticeMilestone] = []
    for span in spans:
        group = by_phase.get(span.phase, [])
        k = len(group)
        if k == 0:
            continue
        seg = days_between(span.start, span.window_end) / k
        for j, m in enumerate(group):
            target = add_days(span.start, round_half_up((j + 1) * seg))
            if days_between(target, span.end) < 0:
                target = span.end
            work_start = add_days(span.start, round_half_up(j * seg * 0.5))
            out.append(
                LatticeMilestone(
                    title=m.title,
                    phase=span.phase,
                    target_date=target,
                    work_start=work_start,
                    rationale=m.rationale,
                )
            )
    return out


def _bands(span: Span, in_span: list[LatticeMilestone]) -> list[tuple[str, str, str, int]]:
    """Weekly bands across the span's 80% window.

    A band with more than one active milestone is labelled `— part i/N` so the
    weekly plan reads as parallel tracks rather than a single thread.
    """
    out: list[tuple[str, str, str, int]] = []
    w = span.start
    stop = span.window_end
    while days_between(w, stop) >= 0:
        # The last band is clamped to the effective window: a band that ran its
        # full 7 days would schedule into the buffer, which is exactly what the
        # buffer exists to protect.
        band_end = add_days(w, 6)
        if days_between(band_end, stop) < 0:
            band_end = stop
        active = [
            m
            for m in in_span
            if days_between(m.work_start, band_end) >= 0
            and days_between(m.target_date, w) >= 0
        ]
        base = active[0].title if active else span.phase
        label = base
        if len(active) > 1:
            for i, m in enumerate(active, start=1):
                if m is active[0]:
                    label = f"{base} — part {i}/{len(active)}"
                    break
        out.append((w, band_end, label, max(1, len(active))))
        w = add_days(band_end, 1)
    return out


def _band_hours(weekly_hours: float, active_count: int) -> float:
    from app.core.util import round1

    return round1(weekly_hours)


def _per_day_hours(
    weekly_hours: float, band_start: str, band_end: str, active_count: int
) -> float:
    from app.core.util import round1

    days = max(1, len(iter_dates(band_start, band_end)))
    return round1(weekly_hours / days / max(1, active_count))
