"""The daily log — what actually happened, as opposed to what was planned.

The execution layer. A logged day is evidence the solver can weigh on the next
run, which is why writing one recomputes drift.

Three corrections to the spec, all in v1's favour
(`CONTRACT-RECONCILIATION.md` #61): the method is **`PUT`**, not `POST`; there is
a **`GET`** the spec omits entirely; and the body is
`{date, text, commitments[], blockers[]}`, not `{date, plan_item_id, done,
minutes, note}`. The per-item arrays are the whole shape — a day has many
commitments and many blockers, and a single `done` boolean cannot express it.

**One rename.** v1's arrays key on `commitment_id`, and the `commitments` entity
no longer exists — migration 0013 folded it into `plan_items`. This service keys
on `plan_item_id` and accepts `commitment_id` as an input alias, so an existing
client keeps working while a new one reads the right name. The stored JSON keeps
whichever key the writer used, because rewriting stored payloads is a migration
and this is not one.
"""
from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import DailyLog
from ..store import drift as drift_store
from ..store import repo
from ..wire import daily_log

router = APIRouter(tags=["state"])

#: v1's caps. The text is a journal entry, not a document.
TEXT_MAX = 5000
NOTE_MAX = 2000
#: Without a date, the GET returns the last week.
WINDOW_DAYS = 7

#: Two spellings of the same key: the new one, and the one v1 stored.
_ITEM_KEYS = ("plan_item_id", "commitment_id")


def _parse_date(v: object, field: str = "date") -> date:
    try:
        return date.fromisoformat(str(v)[:10])
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400, detail=f"Invalid {field} (expected YYYY-MM-DD)"
        )


def _normalise_items(raw: object, *, id_key: str) -> list[dict]:
    """Clamp a client's array. Unknown keys are dropped, not stored.

    `id_key` is `plan_item_id` for commitments and `blocker_id` for blockers —
    the two arrays have different identities and the same shape otherwise.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        identifier = None
        for key in ([id_key] if id_key == "blocker_id" else _ITEM_KEYS):
            value = item.get(key)
            if isinstance(value, str) and value:
                identifier = {key: value}
                break
        if identifier is None:
            continue
        row = {**identifier}
        for key in ("completed", "skipped"):
            if key in item:
                row[key] = bool(item[key])
        row["note"] = str(item.get("note") or "")[:NOTE_MAX]
        out.append(row)
    return out


@router.get("/daily_log")
async def get_daily_log(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
    date: str = Query(default=""),  # noqa: A002 - the query param really is `date`
) -> dict:
    """One day, or the last seven.

    The shape changes with the query — `{"log": …}` for a named day and
    `{"logs": [...]}` without one. That is v1's, and the client branches on it.
    """
    if date:
        row = await repo.get_daily_log(
            session, user_id=user.user_id, log_date=_parse_date(date)
        )
        return {"log": daily_log(row) if row is not None else None}

    since = _parse_date(datetime.now(UTC).date()) - timedelta(days=WINDOW_DAYS - 1)
    rows = await repo.list_daily_logs(session, user_id=user.user_id, since=since)
    return {"logs": [daily_log(r) for r in rows]}


@router.put("/daily_log")
async def upsert_daily_log(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Upsert one day. **The arrays merge; they do not replace.**

    Two surfaces write here — the tick-off UI and the note editor — and a replace
    would make whichever ran second silently erase the other's notes. The merge is
    keyed by item id, so a tick from one surface and a note from the other land on
    the same row.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    if "date" not in body:
        raise HTTPException(status_code=400, detail="date is required")
    log_date = _parse_date(body["date"])

    existing = await repo.get_daily_log(
        session, user_id=user.user_id, log_date=log_date
    )

    commitments_patch = _normalise_items(body.get("commitments"), id_key="plan_item_id")
    blockers_patch = _normalise_items(body.get("blockers"), id_key="blocker_id")

    merged_commitments = repo.merge_by_id(
        list(existing.commitments or []) if existing else [],
        commitments_patch,
        "plan_item_id" if _uses(existing, commitments_patch, "plan_item_id") else "commitment_id",
    )
    merged_blockers = repo.merge_by_id(
        list(existing.blockers or []) if existing else [],
        blockers_patch,
        "blocker_id",
    )

    if existing is None:
        existing = DailyLog(
            user_id=user.user_id,
            log_date=log_date,
            text="",
            commitments=[],
            blockers=[],
        )
        session.add(existing)

    if "text" in body:
        existing.text = str(body.get("text") or "")[:TEXT_MAX]
    existing.commitments = merged_commitments
    existing.blockers = merged_blockers
    existing.updated_at = datetime.now(UTC)
    await session.flush()

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type="upsert:daily_log",
        summary=f"Daily log for {log_date}",
        # Lengths and counts, not the text: the ledger is a record of what
        # happened, and copying a private journal entry into it would widen where
        # that text lives for no benefit.
        payload={
            "date": log_date.isoformat(),
            "text_len": len(existing.text or ""),
            "commitments": len(merged_commitments),
            "blockers": len(merged_blockers),
        },
    )

    # A logged day is evidence: it can move a milestone from "not done" to
    # "done", which is exactly what drift measures.
    try:
        await drift_store.recompute_goal_drift(session, user_id=user.user_id)
    except Exception:
        pass

    # Recorded for the user's *active* goals, since a daily log is not scoped to
    # one. Each goal gets its own row so the badge is per goal.
    try:
        from ..core.blast_radius import radius_for
        from ..store import staleness

        horizons, milestone_moved = radius_for("daily_log.update")
        for goal in await repo.list_goals(
            session, user_id=user.user_id, active_only=True
        ):
            await staleness.record_change(
                session,
                user_id=user.user_id,
                goal_id=goal.id,
                kind="daily_log",
                horizons_moved=horizons,
                milestone_moved=milestone_moved,
                summary=f"Logged {log_date}",
            )
    except Exception:
        pass

    await session.commit()
    return {"log": daily_log(existing)}


def _uses(existing: DailyLog | None, patch: list[dict], new_key: str) -> bool:
    """Which id key this day's stored rows already use.

    Decided once per write so a day that started with `commitment_id` does not
    end up with half its rows keyed the other way — the merge would then see two
    rows for one item and the client would render it twice.
    """
    if patch and any(new_key in row for row in patch):
        return True
    rows = list(existing.commitments or []) if existing else []
    return any(new_key in row for row in rows)
