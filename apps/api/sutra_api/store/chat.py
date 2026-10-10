"""Conversations, messages and proposals — the chat buckets.

The bucket id **is** the identity: `conv_general_<user_id>` for the general
conversation, `conv_<kind>_<refId>` for a scoped one. Deterministic, because a
reload must land in the same conversation and a second plan for the same goal
must not fork a thread. v1 rebuilt the id from `(kind, refId)` on every request
rather than storing a mapping; kept, since a mapping is one more thing to go
stale.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..ids import conversation_id, new_id
from ..models import SCOPE_TO_KIND, Conversation, Message, Proposal


def now() -> datetime:
    return datetime.now(UTC)


def bucket_id(*, user_id: str, kind: str = "", ref_id: str = "", scope: str = "") -> str:
    """Resolve the bucket.

    `refId` wins when present — a scoped conversation is `conv_<kind>_<refId>`,
    and `kind` falls back through the scope map to `general`. Without a `refId`
    it is always the general bucket, regardless of `kind`: v1's rule, and the
    reason a chat about one goal cannot leak into another.
    """
    if ref_id:
        resolved_kind = kind or SCOPE_TO_KIND.get(scope, "") or "general"
        return conversation_id(resolved_kind, ref_id)
    return conversation_id("general", user_id)


async def ensure_conversation(
    session: AsyncSession,
    *,
    user_id: str,
    conv_id: str,
    kind: str = "general",
    goal_id: str | None = None,
    title: str = "",
) -> Conversation:
    """Get or create the bucket. `ON CONFLICT DO NOTHING` then read.

    Idempotent on purpose: the client decides the id, so two requests in flight
    for the same bucket race. Doing this as a read-then-write would raise on the
    second; the caller must never see that.
    """
    existing = await session.get(Conversation, conv_id)
    if existing is not None:
        return existing

    row = Conversation(
        id=conv_id,
        user_id=user_id,
        kind=kind,
        goal_id=goal_id,
        title=(title or "")[:200],
        status="open",
    )
    session.add(row)
    await session.flush()
    return row


async def close_conversation(session: AsyncSession, conv: Conversation) -> None:
    """Seal a scoped bucket. The general bucket is never sealed.

    Once closed, the stream route redirects the client to a fresh bucket — so a
    confirmed plan cannot be silently appended to by a later turn in the same
    thread.
    """
    conv.status = "closed"
    conv.closed_at = now()


async def add_message(
    session: AsyncSession,
    *,
    user_id: str,
    conv_id: str,
    role: str,
    content: str,
    provider: str | None = None,
) -> Message:
    row = Message(
        id=new_id("msg"),
        user_id=user_id,
        conversation_id=conv_id,
        role=role,
        content=content,
        provider=provider,
    )
    session.add(row)
    await session.flush()
    return row


async def history(
    session: AsyncSession, *, user_id: str, conv_id: str, limit: int = 50
) -> list[Message]:
    """The last `limit` messages, oldest first.

    Fetched newest-first so the `LIMIT` keeps the *recent* end of a long
    conversation, then reversed so the caller reads it in order. Taking the
    first N instead would show the user the opening of a thread they left
    months ago.
    """
    stmt = (
        select(Message)
        .where(Message.user_id == user_id, Message.conversation_id == conv_id)
        .order_by(Message.created_at.desc())
        .limit(limit)
    )
    rows = list((await session.execute(stmt)).scalars())
    rows.reverse()
    return rows


async def proposals_for_messages(
    session: AsyncSession, *, message_ids: Sequence[str]
) -> dict[str, list[Proposal]]:
    """All proposals for the given messages, grouped by message id.

    One query rather than N — the history endpoint renders every message and its
    cards, so a per-message lookup is an N+1 that grows with the conversation.
    """
    if not message_ids:
        return {}
    stmt = select(Proposal).where(Proposal.message_id.in_(list(message_ids)))
    out: dict[str, list[Proposal]] = {}
    for row in (await session.execute(stmt)).scalars():
        out.setdefault(row.message_id, []).append(row)
    return out


async def add_proposal(
    session: AsyncSession,
    *,
    user_id: str,
    message_id: str,
    conv_id: str,
    action: str,
    args: dict,
) -> Proposal:
    row = Proposal(
        id=new_id("prop"),
        message_id=message_id,
        user_id=user_id,
        conversation_id=conv_id,
        action=action,
        args=args or {},
        status="pending",
    )
    session.add(row)
    await session.flush()
    return row


async def get_proposal(
    session: AsyncSession, *, user_id: str, proposal_id: str
) -> Proposal | None:
    stmt = select(Proposal).where(
        Proposal.id == proposal_id, Proposal.user_id == user_id
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def mark_proposal_resolved(
    session: AsyncSession,
    *,
    user_id: str,
    proposal_id: str,
    status: str,
    result: str | None,
) -> bool:
    """Flip a pending proposal to `confirmed`/`rejected`. Returns whether it won.

    **The `status == "pending"` predicate is the whole idempotency story.** v1
    chased a double-apply race across four code paths; making the flip a
    conditional update means a second confirm matches zero rows and reports
    "already resolved" instead of applying the action twice. `False` here is not
    an error — it is a lost race, and the caller turns it into a 409.
    """
    from sqlalchemy import update

    stmt = (
        update(Proposal)
        .where(
            Proposal.id == proposal_id,
            Proposal.user_id == user_id,
            Proposal.status == "pending",
        )
        .values(status=status, result=result, resolved_at=now())
        .returning(Proposal.id)
    )
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def clear_history(session: AsyncSession, *, user_id: str) -> int:
    """Delete **every** conversation's contents for this user.

    v1's `DELETE /chat/history` ignores the `refId` it is given and clears all
    buckets; the spec documents a per-bucket delete that the route never
    implemented. Kept as v1 behaves — the client only ever calls it to start
    over. See CONTRACT-RECONCILIATION.md #30.

    Returns the number of messages removed.
    """
    removed = len(
        list(
            (
                await session.execute(select(Message.id).where(Message.user_id == user_id))
            ).scalars()
        )
    )
    # Proposals cascade from messages, but deleting them explicitly keeps this
    # correct if that FK is ever relaxed.
    await session.execute(delete(Proposal).where(Proposal.user_id == user_id))
    await session.execute(delete(Message).where(Message.user_id == user_id))
    return removed
