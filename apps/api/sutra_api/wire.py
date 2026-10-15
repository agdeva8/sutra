"""Row → wire. The only place a shape is decided.

Plain dicts, not response models, and that is deliberate. v1's shapes have
asymmetries a single pydantic model would quietly flatten:

* `POST /plan-items` omits `created_at`; `PATCH` on the same row includes it.
* The source serialiser has three variants — list (no `text_excerpt`), single
  (with it), upload (with `text_pending`).
* A proposal nests its fields under `args` in an SSE frame and **spreads them
  flat** in `/chat/history`.
* `PUT /preferences` echoes the string it was sent, not what it stored.

Each of those is load-bearing for the client, so they are functions here rather
than a model with flags. The shapes come from
`CONTRACT-RECONCILIATION.md`, which resolved every one against the v1 source.

Every date is `YYYY-MM-DD`, every time `HH:MM`, every timestamp ISO-8601. v1's
JavaScript produced `...Z`; Python produces `...+00:00`. Both parse with
`new Date(...)`, and nothing does a string comparison on them — but it is a
visible difference in a diff, so it is noted rather than discovered.
"""
from __future__ import annotations

from datetime import date, datetime, time
from typing import Any

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def iso_date(v: date | None) -> str | None:
    return v.isoformat() if v else None


def iso_dt(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def hhmm(v: time | None) -> str | None:
    """`09:30:00` → `09:30`. v1 sliced the string; this is the same result."""
    return v.strftime("%H:%M") if v else None


def or_empty(v: Any) -> Any:
    """A nullable column the client reads as `?? ""` → send `""` directly.

    v1's serialisers did this per-field (`goal_id ?? ''`). Doing it here means a
    client never has to defend against `null` in a field it treats as a string,
    which is what the `?? ''` was for.
    """
    return v if v is not None else ""


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


def user_me(user: Any) -> dict:
    """`GET /auth/me` — bare, with **both** id spellings.

    v1 sends `user_id`; the spec's `User` says `id` is read too. Emitting both
    costs a key and removes a class of "which one is it" bug on the client.
    """
    return {
        "user_id": user.id,
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "image": user.image,
        "model_provider": user.model_provider or "gemini",
        "is_guest": bool(user.is_guest),
        "persona_key": user.persona_key,
    }


def user_envelope(user: Any) -> dict:
    """`/auth/guest` and `/auth/session` — wrapped, and with `picture`.

    v1's guest response uses `picture` where `/auth/me` uses `image`. Kept
    because the client branches on the two responses differently.
    """
    return {
        "user": {
            "user_id": user.id,
            "id": user.id,
            "email": user.email,
            "name": user.name,
            "image": user.image,
            "picture": user.image,
            "model_provider": user.model_provider or "gemini",
            "is_guest": bool(user.is_guest),
            "persona_key": user.persona_key,
        }
    }


def persona(user: Any) -> dict:
    return {
        "user_id": user.id,
        "name": user.name,
        "email": user.email,
        "model_provider": user.model_provider or "gemini",
        "created_at": iso_dt(user.created_at),
        "is_guest": bool(user.is_guest),
        "persona_key": user.persona_key,
        "persona_weight": user.persona_weight or 0,
    }


# ---------------------------------------------------------------------------
# Goals / milestones / plan items
# ---------------------------------------------------------------------------


def goal_state(goal: Any, source_ids: list[str] | None = None) -> dict:
    """A goal as `/state` carries it.

    `drift_status` is `on_track|at_risk` — not the spec's
    `ahead|on_track|behind`. Nothing has ever written the other two, and
    `computeOverCommitment` and the replan suggestions both branch on `at_risk`
    exactly. See CONTRACT-RECONCILIATION.md #9.
    """
    return {
        "id": goal.id,
        "title": goal.title,
        "horizon": goal.horizon,
        "status": goal.status,
        "why": goal.why,
        "next_action": goal.next_action,
        "target_date": iso_date(goal.target_date),
        "start_date": iso_date(goal.start_date),
        "drift_status": goal.drift_status,
        "weekly_hours": goal.weekly_hours,
        "phase_objectives": goal.phase_objectives or {},
        "sources": source_ids or [],
    }


def goal_row(goal: Any) -> dict:
    """A goal as the CRUD routes return it — snake_case, plus timestamps."""
    return {
        "id": goal.id,
        "user_id": goal.user_id,
        "title": goal.title,
        "horizon": goal.horizon,
        "why": goal.why,
        "next_action": goal.next_action,
        "start_date": iso_date(goal.start_date),
        "target_date": iso_date(goal.target_date),
        "status": goal.status,
        "weekly_hours": goal.weekly_hours,
        "phase_objectives": goal.phase_objectives or {},
        "drift_status": goal.drift_status,
        "life_area": goal.life_area,
        "created_at": iso_dt(goal.created_at),
        "updated_at": iso_dt(goal.updated_at),
    }


def milestone_state(ms: Any) -> dict:
    return {
        "id": ms.id,
        "title": ms.title,
        "target_date": iso_date(ms.target_date),
        "goal_title": ms.goal_title,
        "status": ms.status,
        "goal_id": ms.goal_id,
        "phase": ms.phase,
    }


def milestone_row(ms: Any) -> dict:
    return {
        "id": ms.id,
        "user_id": ms.user_id,
        "goal_id": ms.goal_id,
        "goal_title": ms.goal_title,
        "title": ms.title,
        "target_date": iso_date(ms.target_date),
        "status": ms.status,
        "phase": ms.phase,
        "created_at": iso_dt(ms.created_at),
    }


def plan_item(item: Any, *, with_created_at: bool = True) -> dict:
    """A plan item. `with_created_at=False` reproduces `POST /plan-items`.

    The POST response omits it and the PATCH response includes it. That is a v1
    inconsistency, kept because a client that diffs the two would otherwise see
    a spurious field appear.
    """
    out = {
        "id": item.id,
        "goal_id": item.goal_id,
        "horizon": item.horizon,
        "phase": item.phase,
        "title": item.title,
        "note": item.note,
        # The session's own sentence on what it involves. `None` for rows written before the column
        # existed, which the client treats as "no description" rather than as an empty one.
        "description": getattr(item, "description", None),
        "why": getattr(item, "why", None),
        "done_hours": getattr(item, "done_hours", None),
        "start_date": iso_date(item.start_date),
        "end_date": iso_date(item.end_date),
        "due_date": iso_date(item.due_date),
        "weekly_hours": item.weekly_hours,
        "status": item.status,
    }
    if with_created_at:
        out["created_at"] = iso_dt(item.created_at)
    return out


def plan_item_row(item: Any) -> dict:
    """A plan item as the planner emits it — mirrors `PlanItemRow`, no id.

    The agent's own contract: `horizon` and `title` are the only required
    fields, and dates come from the solver. No `id`, because an uncommitted
    plan has no rows yet.

    Dates are coerced rather than passed through, because this serialiser is
    called with two different things: the agent's `PlanItemRow`, whose dates are
    already ISO strings, and a persisted `PlanItem` ORM row, whose dates are
    `date` objects. One function for both means the two paths cannot drift into
    producing `"2026-10-10"` and `date(2026, 10, 10)` in the same field.
    """
    return {
        "horizon": item.horizon,
        "phase": item.phase,
        "title": item.title,
        "note": item.note,
        "start_date": _isoish(item.start_date),
        "end_date": _isoish(item.end_date),
        "due_date": _isoish(item.due_date),
        "weekly_hours": item.weekly_hours,
        "status": item.status,
    }


def _isoish(v: Any) -> Any:
    """A date-ish value as a string, or the value unchanged when it already is one."""
    return v.isoformat() if isinstance(v, (date, datetime)) else v


# ---------------------------------------------------------------------------
# Capacity
# ---------------------------------------------------------------------------


def blocker(row: Any) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "title": row.title,
        "start_date": iso_date(row.start_date),
        "end_date": iso_date(row.end_date),
        "note": row.note,
        "created_at": iso_dt(row.created_at),
    }


def time_block(row: Any) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "block_date": iso_date(row.block_date),
        "start_time": hhmm(row.start_time),
        "end_time": hhmm(row.end_time),
        "label": row.label,
        "kind": row.kind,
        "source": row.source,
        "source_id": row.source_id,
        "goal_id": row.goal_id,
        "goal_title": row.goal_title,
        "note": row.note,
        "why": getattr(row, "why", None),
        "created_at": iso_dt(row.created_at),
    }


# ---------------------------------------------------------------------------
# Sources — three variants, deliberately
# ---------------------------------------------------------------------------


def source_list_row(row: Any) -> dict:
    """List shape: **no** `text_excerpt`. v1 omitted it to keep the list small."""
    return {
        "id": row.id,
        "user_id": row.user_id,
        "goal_id": or_empty(row.goal_id),
        "goal_title": row.goal_title,
        "kind": row.kind,
        "storage_path": row.storage_path,
        "original_filename": row.original_filename,
        "content_type": row.content_type,
        "size": row.size,
        "url": row.url,
        "is_deleted": bool(row.is_deleted),
        "created_at": iso_dt(row.created_at),
    }


def source_row(row: Any) -> dict:
    """Single-row shape: adds `text_excerpt` (a nullable column sent as `""`)."""
    out = source_list_row(row)
    out["text_excerpt"] = or_empty(row.text_excerpt)
    return out


def source_upload_row(row: Any, *, text_pending: bool) -> dict:
    """Upload shape: adds `text_pending`.

    Response-only — there is no such column. It is `isImage`, and the client
    shows a spinner on it. v1 never cleared it; an empty excerpt is the
    downstream "still unreadable" signal, which is why OCR can land later
    without a second round trip.
    """
    out = source_list_row(row)
    out["text_pending"] = bool(text_pending)
    return out


def memory(row: Any) -> dict:
    """A photo/Instagram keepsake — **not** the spec's `{id, text, ...}`.

    See CONTRACT-RECONCILIATION.md #53: the spec documents `user_facts` here.
    """
    return {
        "id": row.id,
        "kind": row.kind,
        "caption": row.caption,
        "goal_id": row.goal_id,
        "goal_title": row.goal_title or None,
        "source_id": row.source_id,
        "external_url": row.external_url,
        "instagram_shortcode": row.instagram_shortcode,
        "width": row.width,
        "height": row.height,
        "mime_type": row.mime_type,
        "size_bytes": row.size_bytes,
        "occurred_on": iso_date(row.occurred_on),
        "created_at": iso_dt(row.created_at),
    }


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------


def proposal_sse(row: Any) -> dict:
    """A proposal in an SSE `tools` frame: fields **nested** under `args`."""
    return {
        "id": row.id,
        "action": row.action,
        "args": row.args or {},
        "status": row.status,
    }


def proposal_history(row: Any) -> dict:
    """A proposal in `/chat/history`: fields **spread flat**.

    `{id, action, status, ...args}` — so `title` sits beside `status`, not under
    `args`. `ToolConfirmationPrompt.flatProposal` is the one place that
    reconciles the two spellings, and it tolerates either. See #29.
    """
    out = {"id": row.id, "action": row.action, "status": row.status}
    out.update(row.args or {})
    return out


def chat_message(row: Any, proposals: list[Any]) -> dict:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "role": row.role,
        "content": row.content,
        "provider": row.provider,
        "proposals": [proposal_history(p) for p in proposals],
        "created_at": iso_dt(row.created_at),
    }


def audit_entry(row: Any) -> dict:
    """/audit's shape — includes `payload`, which the spec omits.

    The ledger is far less useful without it: `replan-suggestions` reads
    `payload.freed_weekly_hours` to detect a goal that freed capacity, and
    `payload.args` to reconstruct what a proposal actually did.
    """
    return {
        "id": row.id,
        "user_id": row.user_id,
        "type": row.type,
        "summary": row.summary,
        "payload": row.payload or {},
        "created_at": iso_dt(row.created_at),
    }


def daily_log(row: Any) -> dict:
    """The execution layer. Keyed by date, not id — the pair is the identity."""
    return {
        "date": iso_date(row.log_date),
        "text": row.text,
        "commitments": row.commitments or [],
        "blockers": row.blockers or [],
        "updated_at": iso_dt(row.updated_at),
    }


# ---------------------------------------------------------------------------
# Motivation
# ---------------------------------------------------------------------------


def motivation_item(item: dict) -> dict:
    """One nudge. `frame` is the point of the card — why this, for this user, now."""
    return {
        "id": item.get("id", ""),
        "kind": item.get("kind", ""),
        "title": item.get("title", ""),
        "url": item.get("url", ""),
        "author": item.get("author", ""),
        "duration": item.get("duration", ""),
        "frame": item.get("frame", ""),
        "excerpt": item.get("excerpt", ""),
        "score_total": item.get("score_total", 0),
    }


def motivation(bucket: str, items: list[dict], cache: str, generated_at: str) -> dict:
    """`cache` is a polling switch, and its enum is `hit|miss|stale`.

    The spec says `warming`; that value does not exist in v1 anywhere. `miss`
    and `stale` **are** the warming signal — the client polls every 5s and gives
    up at 60s, so a refusal to return one of them is a request storm. See #58.
    """
    return {
        "bucket": bucket,
        "items": [motivation_item(i) for i in items],
        "generated_at": generated_at,
        "cache": cache,
    }
