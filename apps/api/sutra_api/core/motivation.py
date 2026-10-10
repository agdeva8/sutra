"""Which nudge bucket the user is in, and what makes their state change.

Pure, ported from v1's `lib/motivation/state.ts`.

The **state hash is the whole reason a stale recommendation cannot be served**:
it is part of the cache key, so when the user's situation moves the key moves
with it and the old row is simply not a candidate. Nothing has to be invalidated,
and nothing can be forgotten.

The bucket order is a priority, not a set of independent tests — and it is the
order that matters:

1. `overdue` — a milestone is past its date. Most urgent, so it wins outright.
2. `stuck` — no active goals at all.
3. `dormant` — active goals, but none touched in three weeks.
4. `stuck` — the fallback.

Note the asymmetry: `dormant` requires *evidence of a lapse*, so a brand-new user
with a goal created today falls through to `stuck`, which is the right bucket for
"nothing is moving yet".
"""
from __future__ import annotations

import hashlib
from datetime import UTC, date, datetime, timedelta

#: After this many days with no edit, an active goal's owner is dormant.
DORMANT_AFTER_DAYS = 21

BUCKETS = ("overdue", "dormant", "stuck")


def detect_bucket(
    *,
    today: date,
    milestones: list[dict],
    goals: list[dict],
    now: datetime | None = None,
) -> str:
    """`overdue` | `dormant` | `stuck`.

    Milestones: `{"status", "target_date"}`. Goals: `{"status", "updated_at"}`.
    """
    now = now or datetime.now(UTC)

    for m in milestones:
        target = m.get("target_date")
        if not target or m.get("status") == "done":
            continue
        if str(target)[:10] < today.isoformat():
            return "overdue"

    active = [g for g in goals if g.get("status") == "active"]
    if not active:
        return "stuck"

    cutoff = now - timedelta(days=DORMANT_AFTER_DAYS)
    for g in active:
        updated = g.get("updated_at")
        if updated is None:
            continue
        stamp = updated if isinstance(updated, datetime) else _parse(str(updated))
        # A goal with an unparseable timestamp counts as *recently* touched:
        # the alternative is calling every user dormant because of one bad row.
        if stamp is None or stamp >= cutoff:
            return "stuck"

    return "dormant"


def _parse(raw: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def compute_state_hash(*, overdue_ids: list[str], goals: list[dict]) -> str:
    """A stable digest of "what the user's plan looks like right now".

    Deterministic and order-independent: the inputs are sorted before hashing, so
    two calls with the same state in a different row order produce the same key
    and hit the same cache entry.
    """
    parts = [
        *sorted(overdue_ids),
        *sorted(
            f"{g.get('id')}:{g.get('status')}:{g.get('updated_at')}" for g in goals
        ),
    ]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]
