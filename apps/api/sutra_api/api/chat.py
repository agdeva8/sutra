"""Chat — the conversational surface, streaming and not.

Five routes, and the shapes are v1's throughout
(`CONTRACT_RECONCILIATION.md` §5). The three that a well-meaning reader would
"fix" back to the spec's version:

* **`/chat/stream` takes ten fields, not five.** `auto_answer`,
  `proactive_propose`, `provider`, `title`, `helperText` and `sourceIds` are all
  sent on every turn; dropping them silently loses mode hints and attachments.
* **`/chat/refine` takes ids** (`message_id`, `proposal_id`, `thought`) and
  answers `{"proposal": …}` — not `{message, proposal, refId}` → bare `Proposal`.
* **`DELETE /chat/history` ignores its `refId`** and clears every bucket,
  answering `{"success": true}`.

## The bucket model

A conversation id *is* a bucket key: `conv_general_<user_id>` for the general
conversation, `conv_<kind>_<refId>` for a scoped one. Deterministic, because a
reload must land in the same thread and a second plan for one goal must not fork.

A scoped bucket can be **sealed** (the confirm flow closes it). When the client
aims at a sealed bucket, the server mints a fresh one and says so on the `done`
frame — `redirected: true` plus the new `ref_id` — and the client swaps its ref.
Without that, a confirmed plan would keep accumulating turns nobody wants.
"""
from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sutra_chat.clarify_options import enrich
from sutra_chat.tools_block import parse_proposals, split_prose_and_tools
from sutra_chat.turn import stream_turn

from agentv2 import chat_turn, default_chat, local_now

from ..agent_store import SqlStore
from ..db import get_session
from ..rate_limit import llm_rate_limit
from ..deps import CurrentUser, planner_enabled_for, require_user
from ..llm import get_complete, provider_status
from ..models import SCOPE_TO_KIND, Conversation, Milestone, PlanItem, Proposal
from ..store import chat as chat_store
from ..store import repo
from ..stream import (
    delta,
    done,
    error as error_frame,
    frame,
    needs_clarification,
    sse_response,
    status as status_frame,
    tools as tools_frame,
)
from ..wire import chat_message, proposal_sse

#: Recent turns the planner sees with a chat message. Generous; it only bounds a query.
CHAT_CONTEXT_TURNS = 12

router = APIRouter(tags=["chat"])

#: v1's history window per scope. The general bucket is the long-running one.
HISTORY_LIMIT = 200
HISTORY_DEFAULT = 50
CONTEXT_TURNS_GENERAL = 24
CONTEXT_TURNS_SCOPED = 12

#: The kinds a scoped conversation may be. `not_planned` is v1's answer for
#: anything else.
#: Roles a stored turn may carry into the model call.
CHAT_ROLES = frozenset({"user", "assistant"})
KIND_ADD_GOAL = "add_goal"
INTENTS = frozenset(
    {"add_goal", "plan_day", "review_progress", "edit_goal", "drop_goal"}
)


# ---------------------------------------------------------------------------
# context
# ---------------------------------------------------------------------------


async def _build_context(session: AsyncSession, *, user_id: str) -> str:
    """The live-state block injected into the system prompt.

    Kept compact on purpose. This is pasted into *every* turn, so its size is a
    per-message cost, and a model given forty lines of state attends to none of
    it. What goes in: the goals with their horizons and dates, what is in flight
    this week, and anything overdue.
    """
    goals = await repo.list_goals(session, user_id=user_id, limit=50)
    milestones = await repo.list_milestones(session, user_id=user_id, limit=100)
    items = await repo.list_plan_items(session, user_id=user_id, limit=200)
    today = datetime.now(UTC).date()

    lines: list[str] = [f"Today is {today.isoformat()}."]

    active = [g for g in goals if g.status == "active"]
    if goals:
        lines.append("\nGOALS:")
        for g in goals:
            marker = "" if g.status == "active" else f" [{g.status}]"
            target = f" → {g.target_date}" if g.target_date else ""
            hours = f", {g.weekly_hours}h/week" if g.weekly_hours else ""
            lines.append(f"- {g.title} ({g.horizon}){target}{hours}{marker}")

    overdue = [
        m for m in milestones if m.target_date and m.target_date < today and m.status != "done"
    ]
    if overdue:
        lines.append("\nOVERDUE MILESTONES:")
        lines.extend(f"- {m.title} (was due {m.target_date})" for m in overdue[:10])

    upcoming = [
        i
        for i in items
        if i.horizon in ("daily", "weekly") and i.status != "done" and i.start_date
    ]
    if upcoming:
        lines.append("\nIN FLIGHT:")
        lines.extend(
            f"- {i.title} ({i.start_date})" for i in upcoming[:12]
        )

    if not active:
        lines.append("\nNo active goals yet.")
    return "\n".join(lines)


#: What the user is told while the coach works, in the order it happens. Plain words, no jargon.
STATUS_READING = "Reading what you wrote…"
STATUS_SOURCES = "Going through what you attached ({n})…"
STATUS_HISTORY = "Going back over what we've talked about…"
STATUS_INTERVIEW = "Working out what would change your plan the most…"
STATUS_PROPOSE = "Putting your goal and first steps together…"


def _status_lines(scoped_kind: str, *, n_sources: int, has_history: bool, interview: bool) -> list[str]:
    """The progress lines for one chat turn, sent before the model is called."""
    lines = [STATUS_READING]
    if n_sources:
        lines.append(STATUS_SOURCES.format(n=n_sources))
    if has_history:
        lines.append(STATUS_HISTORY)
    lines.append(STATUS_INTERVIEW if scoped_kind == KIND_ADD_GOAL and interview else STATUS_PROPOSE)
    return lines


#: Per source, how much of its text goes into the prompt. Matches the stored excerpt cap.
SOURCE_PROMPT_CHARS = 8000


async def _sources_block(session: AsyncSession, *, user_id: str, source_ids: list[str]) -> str:
    """What the user attached to this chat, as a block the model must use.

    Without it the coach never sees an attachment: the ids only ride along to be linked to the goal.
    """
    rows = await repo.sources_by_ids(session, user_id=user_id, ids=source_ids)
    parts: list[str] = []
    for row in rows:
        name = row.url or row.original_filename
        text = (row.text_excerpt or "").strip()
        parts.append(f"--- {name} ---\n{text[:SOURCE_PROMPT_CHARS] or '[no readable text in this source yet]'}")
    if not parts:
        return ""
    return (
        "\n\nATTACHED SOURCES (the user attached these to this goal — read them, ask about what they leave "
        "unclear, and build the plan from what they say):\n" + "\n\n".join(parts)
    )


async def _history_text(
    session: AsyncSession, *, user_id: str, conv_id: str, limit: int
) -> list[dict]:
    rows = await chat_store.history(
        session, user_id=user_id, conv_id=conv_id, limit=limit
    )
    return [{"role": r.role, "content": r.content} for r in rows]


# ---------------------------------------------------------------------------
# streaming chat
# ---------------------------------------------------------------------------


async def _resolve_bucket(
    session: AsyncSession,
    *,
    user_id: str,
    scope: str,
    ref_id: str,
    kind: str,
    title: str,
) -> tuple[str, str, bool]:
    """`(conversation_id, effective_ref_id, redirected)`.

    The redirect is the interesting part: aiming at a sealed bucket is a normal
    client situation (the user kept typing after confirming), and it must not be
    an error. Minting a fresh ref keeps the conversation going without appending
    to a plan that is already committed.
    """
    scoped_kind = kind or SCOPE_TO_KIND.get(scope, "") or "general"

    if not (scope and ref_id):
        conv_id = chat_store.bucket_id(user_id=user_id, kind="general")
        await chat_store.ensure_conversation(
            session, user_id=user_id, conv_id=conv_id, kind="general"
        )
        return conv_id, "", False

    conv_id = chat_store.bucket_id(user_id=user_id, kind=scoped_kind, ref_id=ref_id)
    existing = await session.get(Conversation, conv_id)

    if existing is not None and existing.status == "closed":
        fresh = f"new_goal_{uuid4().hex[:8]}"
        conv_id = chat_store.bucket_id(user_id=user_id, kind=scoped_kind, ref_id=fresh)
        await chat_store.ensure_conversation(
            session,
            user_id=user_id,
            conv_id=conv_id,
            kind=scoped_kind,
            title=title,
        )
        return conv_id, fresh, True

    await chat_store.ensure_conversation(
        session,
        user_id=user_id,
        conv_id=conv_id,
        kind=scoped_kind,
        goal_id=ref_id if scope == "goal" and not ref_id.startswith("new_goal_") else None,
        title=title,
    )
    return conv_id, ref_id, False


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """One conversational turn, streamed.

    The client accumulates `content` from `delta` frames and ignores everything
    else until a terminal frame arrives.

    Unlike v1, an auth failure here is JSON rather than a plain-text body. The
    client never reads it — it checks `res.ok` and throws `"stream failed"` — so
    the change is invisible, and JSON is what every other route answers with.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Bad request")

    message = str((body or {}).get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Bad request")

    # v1's resolution, kept exactly: an explicit `false` means ask, an explicit
    # `true` means propose, and *unset* defaults to propose. Opting out of
    # clarification is the client's job, not the default.
    raw_auto = body.get("auto_answer")
    auto_answer = True if raw_auto is None else bool(raw_auto)
    if body.get("proactive_propose") is True:
        auto_answer = True
    clarify = (
        body.get("clarify") is True
        or body.get("grillMe") is True
        or body.get("grill_me") is True
    )

    scope = str(body.get("scope") or "")
    ref_id = str(body.get("refId") or body.get("ref_id") or "")
    kind = str(body.get("kind") or "")
    title = str(body.get("title") or "")
    scoped_kind = kind or SCOPE_TO_KIND.get(scope, "") or "general"

    conv_id, effective_ref, redirected = await _resolve_bucket(
        session, user_id=user.user_id, scope=scope, ref_id=ref_id, kind=kind, title=title
    )

    user_message = await chat_store.add_message(
        session,
        user_id=user.user_id,
        conv_id=conv_id,
        role="user",
        content=message,
    )
    await session.commit()

    context = await _build_context(session, user_id=user.user_id)
    turns = await _history_text(
        session,
        user_id=user.user_id,
        conv_id=conv_id,
        limit=(
            CONTEXT_TURNS_GENERAL if scoped_kind == "general" else CONTEXT_TURNS_SCOPED
        ),
    )
    # The row just written is in the history; drop it so it is not sent twice.
    if turns and turns[-1]["content"] == message:
        turns = turns[:-1]

    source_ids = [
        s
        for s in (body.get("sourceIds") or [])
        if isinstance(s, str) and s
    ][:10]

    if source_ids:
        context += await _sources_block(session, user_id=user.user_id, source_ids=source_ids)

    async def complete(system: str, user_text: str) -> str:
        """The seam. `apps/agent`'s completion, wrapped so this route owns no
        provider logic — see `sutra_api/llm.py`."""
        return await _text_complete(system, user_text, turns)

    async def events():
        delivered: list[str] = []
        try:
            for line in _status_lines(scoped_kind, n_sources=len(source_ids), has_history=bool(turns), interview=not auto_answer):
                yield frame(status_frame(line))
            async for event, payload in stream_turn(
                complete=complete,
                message=message,
                context=context,
                auto_answer=auto_answer,
                clarify=clarify,
                proactive_propose=body.get("proactive_propose") is True,
                scoped_kind=scoped_kind,
            ):
                if event == "delta":
                    delivered.append(str(payload))
                    yield frame(delta(str(payload), ref_id=effective_ref or None))
                elif event == "tools":
                    proposals = list(payload)  # type: ignore[arg-type]
                    # Persist before announcing: a card the server has no row for
                    # cannot be confirmed, and the confirm route looks the id up.
                    assistant = await chat_store.add_message(
                        session,
                        user_id=user.user_id,
                        conv_id=conv_id,
                        role="assistant",
                        content="".join(delivered),
                        provider=provider_status()["provider"],
                    )
                    for proposal in proposals:
                        args = dict(proposal.args)
                        if proposal.action == "create_goal" and source_ids:
                            args["source_ids"] = source_ids
                        await chat_store.add_proposal(
                            session,
                            user_id=user.user_id,
                            message_id=assistant.id,
                            conv_id=conv_id,
                            action=proposal.action,
                            args=args,
                        )
                    await session.commit()
                    yield frame(
                        tools_frame(
                            [proposal_sse(p) for p in await _rows_for(
                                session, user_id=user.user_id, message_id=assistant.id
                            )],
                            message_id=assistant.id,
                        )
                    )
                elif event == "needs_clarification":
                    turn = payload
                    assistant = await chat_store.add_message(
                        session,
                        user_id=user.user_id,
                        conv_id=conv_id,
                        role="assistant",
                        content=str(turn.prose or ""),  # type: ignore[attr-defined]
                        provider=provider_status()["provider"],
                    )
                    await session.commit()
                    yield frame(
                        needs_clarification(
                            enrich(list(turn.questions)),  # type: ignore[attr-defined]
                            message_id=assistant.id,
                            prompt=str(turn.needs_clarification),  # type: ignore[attr-defined]
                        )
                    )
                elif event == "done":
                    turn = payload
                    text = "".join(delivered)
                    if turn.outcome == "prose":  # type: ignore[attr-defined]
                        # A plain reply — persist it, since no other branch did.
                        assistant = await chat_store.add_message(
                            session,
                            user_id=user.user_id,
                            conv_id=conv_id,
                            role="assistant",
                            content=str(turn.prose or ""),  # type: ignore[attr-defined]
                            provider=provider_status()["provider"],
                        )
                        await session.commit()
                        message_id = assistant.id
                    else:
                        message_id = user_message.id
                    yield frame(
                        done(
                            message_id=message_id,
                            provider=provider_status()["provider"],
                            ref_id=effective_ref or None,
                            conversation_id=conv_id,
                            redirected=redirected,
                            text=text or str(getattr(turn, "prose", "")),
                        )
                    )
        except Exception as exc:  # noqa: BLE001
            # After the 200 and the headers, an error frame is the only way left
            # to report a failure.
            yield frame(error_frame(str(exc)))

    return sse_response(events())


async def _rows_for(
    session: AsyncSession, *, user_id: str, message_id: str
) -> list[Proposal]:
    rows = (
        await session.execute(
            select(Proposal).where(
                Proposal.user_id == user_id, Proposal.message_id == message_id
            )
        )
    ).scalars()
    return list(rows)


async def _text_complete(
    system: str, user_text: str, turns: list[dict]
) -> str:
    """One model call, text in and text out.

    The chat surface reads raw prose with a `[[TOOLS]]` block, not JSON, so this
    bypasses the structured-completion seam (`get_complete`), which would force
    the reply into a schema and fail every turn. Earlier turns go in as real
    messages so the model sees the conversation, not just the latest line.
    """
    chat = default_chat()
    messages = [("system", system)]
    messages += [(t["role"], t["content"]) for t in turns if t.get("role") in CHAT_ROLES]
    messages.append(("user", user_text))
    reply = await asyncio.to_thread(chat.invoke, messages)
    return str(reply.content)


# ---------------------------------------------------------------------------
# history
# ---------------------------------------------------------------------------


@router.get("/chat/history")
async def chat_history(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
    refId: str = "",  # noqa: N803 - the query param really is camelCase
    kind: str = "",
    scope: str = "",
    limit: int = HISTORY_DEFAULT,
) -> list[dict]:
    """A **bare array** — not `{messages: […]}`.

    The v1 agent wrapped it and the frontend broke on the wrapper. The proposal
    rows are also **spread flat** here (`{id, action, status, ...args}`), unlike
    in an SSE `tools` frame, which nests them under `args`.
    """
    capped = max(1, min(limit or HISTORY_DEFAULT, HISTORY_LIMIT))
    conv_id = chat_store.bucket_id(
        user_id=user.user_id, kind=kind, ref_id=refId, scope=scope
    )
    rows = await chat_store.history(
        session, user_id=user.user_id, conv_id=conv_id, limit=capped
    )
    by_message = await chat_store.proposals_for_messages(
        session, message_ids=[r.id for r in rows]
    )
    return [chat_message(r, by_message.get(r.id, [])) for r in rows]


@router.delete("/chat/history")
async def clear_history(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
    refId: str = "",  # noqa: N803 - accepted and ignored, as in v1
) -> dict:
    """Clear **every** bucket. `{"success": true}`, not `{"ok": true}`.

    The `refId` is accepted and ignored, and that is v1's behaviour rather than a
    bug being preserved: the client only calls this to start over, and a
    per-bucket delete was never implemented on either side.
    """
    await chat_store.clear_history(session, user_id=user.user_id)
    await session.commit()
    return {"success": True}


# ---------------------------------------------------------------------------
# the planner, from a chat turn
# ---------------------------------------------------------------------------


@router.post("/chat/plan", dependencies=[Depends(llm_rate_limit)])
async def chat_plan(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Run the planner from a chat turn.

    **Both envelopes.** The client routes on `status` (`disabled` makes it fall
    back to the SSE path); the v2 contract carries `kind`. Emitting only one of
    them breaks either the fallback or the contract, so both are sent — see
    `CONTRACT_RECONCILIATION.md` #31.

    Slower than `/chat/stream` and the client knows it: it opts into a 60s
    timeout for this call specifically.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    message = str(body.get("message") or "")
    if not message:
        raise HTTPException(status_code=400, detail="Missing message")

    kind = str(body.get("kind") or "")
    if kind and kind not in INTENTS:
        return {"status": "not_planned", "kind": "no_change", "prose": ""}

    if kind == KIND_ADD_GOAL:
        # The Add-goal dialog asks its own questions and offers a goal card to confirm. Filing the
        # goal from here would skip both, so this hands the turn to the ordinary chat.
        return {"status": "not_planned", "kind": "no_change", "prose": ""}

    if not planner_enabled_for(user):
        return {"status": "disabled"}

    conv_id, effective_ref, _redirected = await _resolve_bucket(
        session,
        user_id=user.user_id,
        scope=str(body.get("scope") or ""),
        ref_id=str(body.get("refId") or body.get("ref_id") or ""),
        kind=kind,
        title=str(body.get("title") or ""),
    )
    await chat_store.add_message(
        session,
        user_id=user.user_id,
        conv_id=conv_id,
        role="user",
        content=message,
    )
    await session.commit()

    # The turn runs on agentv2: it files what it can, proposes goal and availability changes for the
    # user to confirm, and hands everything else back to the ordinary chat (`not_planned`).
    now = local_now(request.headers.get("x-timezone"))
    past = await chat_store.history(session, user_id=user.user_id, conv_id=conv_id, limit=CHAT_CONTEXT_TURNS)
    turn = await chat_turn(
        SqlStore(session, user.user_id, today=now.date()), message,
        history=[(m.role, m.content) for m in past[:-1]], now=now, ref=conv_id,
    )

    base = {
        "message_id": "",
        "conversation_id": conv_id,
        "ref_id": effective_ref,
        "kind": "ok" if turn.kind == "ok" else "no_change",
        "thread_id": "",
    }

    if turn.kind == "not_planned":
        await session.commit()  # keep the filed rows, if any, and the user's message
        return {"status": "not_planned", **base, "prose": ""}

    if turn.kind == "clarify":
        await session.commit()
        return {"status": "clarify", **base, "prose": turn.prose, "questions": enrich(list(turn.questions))}

    prose = "\n".join([p for p in [turn.prose, *turn.applied] if p])
    reply = await chat_store.add_message(
        session, user_id=user.user_id, conv_id=conv_id, role="assistant", content=prose,
        provider=provider_status()["provider"],
    )
    rows = [
        await chat_store.add_proposal(
            session, user_id=user.user_id, message_id=reply.id, conv_id=conv_id, action=p["action"], args=p["args"]
        )
        for p in turn.proposals
    ]
    await session.commit()
    return {
        "status": "ok",
        **base,
        "message_id": reply.id,
        "prose": prose,
        "proposals": [proposal_sse(r) for r in rows],
        "plan": None,
        "plan_items": [],
    }


@router.post("/chat/refine")
async def chat_refine(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Refine a pending proposal in place.

    The proposal's **id is preserved** and its `args` are replaced — the card the
    user is looking at keeps its identity, so the modal swaps content rather than
    gaining a second card. One model call, no history, no new message row.

    A model that returns no block is a **422, not a 502**: the request was fine,
    and the user can edit their note and try again. That distinction is the
    difference between "try again" and "the server is broken".
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    body = body or {}

    message_id = str(body.get("message_id") or "")
    proposal_id = str(body.get("proposal_id") or "")
    thought = str(body.get("thought") or "")
    if not (message_id and proposal_id and thought):
        raise HTTPException(
            status_code=400,
            detail="message_id, proposal_id, and thought are required",
        )
    if len(thought) > 2000:
        raise HTTPException(
            status_code=400, detail="thought is too long (max 2000 chars)"
        )

    row = await chat_store.get_proposal(session, user_id=user.user_id, proposal_id=proposal_id)
    # Scoped by user in the query, so "not found" and "someone else's" are the
    # same answer — a 403 would confirm the id exists.
    if row is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    if row.message_id != message_id:
        raise HTTPException(
            status_code=404, detail="Proposal does not belong to this message"
        )
    if row.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Proposal is already {row.status}; only pending proposals can be refined.",
        )

    from ..store.executor import apply_proposal  # noqa: F401  (documented below)
    from sutra_chat.prompts import SYSTEM_PROMPT

    previous = row.args or {}
    prompt = (
        f"The user is refining a proposed action.\n"
        f"ACTION: {row.action}\n"
        f"CURRENT ARGS: {previous}\n"
        f"THEIR NOTE: {thought}\n\n"
        "Return the corrected action as a single-item tools block, same action "
        "name unless their note changes it. Prose first, then the block."
    )

    from pydantic import BaseModel

    class _Prose(BaseModel):
        model_config = {"extra": "ignore"}

        text: str = ""

    try:
        completion = await get_complete()(SYSTEM_PROMPT, prompt, _Prose)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Refine failed: {exc}")

    text = completion.text or ""
    if not text.strip():
        raise HTTPException(
            status_code=502, detail="Refine produced no response from the model."
        )
    _prose, block = split_prose_and_tools(text)
    refined = parse_proposals(block)
    if not refined:
        raise HTTPException(
            status_code=422,
            detail=(
                "The coach needs more clarity before re-proposing. "
                "Edit your note and try again."
            ),
        )

    chosen = refined[0]
    before = dict(previous)
    row.args = chosen.args
    # The action may legitimately change — a note can turn "create" into "edit".
    if chosen.action:
        row.action = chosen.action
    await session.flush()

    await repo.write_audit(
        session,
        user_id=user.user_id,
        type=f"refine:{row.action}",
        summary=f"User refined proposal ({row.action})",
        payload={
            "proposal_id": row.id,
            "message_id": message_id,
            "thought": thought,
            "before": before,
            "after": chosen.args,
        },
    )
    await session.commit()
    return {
        "proposal": {
            "id": row.id,
            "action": row.action,
            "args": row.args,
            "status": row.status,
        }
    }
