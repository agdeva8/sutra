"""General CRUD for the four calendar block kinds.

POST   /blocks          — create a block
GET    /blocks          — list blocks (?kind=event&day=YYYY-MM-DD&from=&to=)
GET    /blocks/{id}    — get one block
PATCH  /blocks/{id}    — update a block
DELETE /blocks/{id}    — delete a block
POST   /audit/{id}/undo — generic undo
GET    /state/version   — current board version
"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agentv2.contracts import Origin
from agentv2.contracts.blocks import Block, BlockKind
from agentv2.gateway.crud import add_item, update_item, delete_item, new_id

from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import CalendarBlock, User
from ..agent_store import SqlStore

router = APIRouter(tags=["blocks"])


# ---------------------------------------------------------------------------
# request / response models
# ---------------------------------------------------------------------------

class CreateBlockReq(BaseModel):
    block: Block


class UpdateBlockReq(BaseModel):
    block: Block


class BlockResponse(BaseModel):
    id: str
    version: int
    block: Block
    audit_id: str | None = None
    displaced_goals: list[str] = []


class BlockListResponse(BaseModel):
    items: list[Block]
    version: int
    audit_id: str | None = None
    displaced_goals: list[str] = []


class VersionResponse(BaseModel):
    version: int


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def _get_version(session: AsyncSession, user_id: str) -> int:
    row = await session.get(User, user_id)
    return getattr(row, "board_version", 0) if row else 0


def _block_from_data(data: dict) -> Block:
    from agentv2.contracts.blocks import BLOCK_ADAPTER
    return BLOCK_ADAPTER.validate_python(data)


def _on_day(block: Block, day: date) -> bool:
    bk = block.block_kind
    if bk == "event":
        return block.day == day
    elif bk == "task":
        return block.day == day
    elif bk == "away":
        return block.start_date <= day <= block.end_date
    elif bk == "milestone":
        return block.target_date == day
    return False


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@router.post("/blocks", response_model=BlockResponse, status_code=status.HTTP_201_CREATED)
async def create_block(
    req: CreateBlockReq,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """Create one block of any kind (event, task, away, milestone)."""
    block = req.block
    block.id = new_id()

    from ..deps import local_now
    today = local_now(user.timezone).date()
    store = SqlStore(session, user.user_id, today=today)
    result = await add_item(store, block, Origin(source="manual"))

    from agentv2.contracts.results import Rejected, Applied
    if isinstance(result, Rejected):
        await session.commit()  # Log the reject row
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"violations": [v.model_dump() for v in result.violations]},
        )

    assert isinstance(result, Applied), "Expected Applied result"
    await session.commit()
    return BlockResponse(
        id=block.id,
        version=result.version,
        block=block,
        audit_id=result.audit_id,
        displaced_goals=result.displaced_goals
    )


@router.get("/blocks", response_model=BlockListResponse)
async def list_blocks(
    kind: Annotated[BlockKind | None, Query(description="Filter by block kind")] = None,
    day: Annotated[date | None, Query(description="Filter by day")] = None,
    from_: Annotated[date | None, Query(description="Range start (YYYY-MM-DD)", alias="from")] = None,
    to: Annotated[date | None, Query(description="Range end (YYYY-MM-DD)")] = None,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """List blocks, optionally filtered by kind and/or day. Supports date range with repeat expansion."""
    from agentv2.core.recurring import occurrences as _occurrences
    from agentv2.config import RECURRING_HORIZON_DAYS

    stmt = select(CalendarBlock).where(CalendarBlock.user_id == user.user_id)
    if kind:
        stmt = stmt.where(CalendarBlock.block_kind == kind)
    rows = (await session.execute(stmt)).scalars().all()

    items: list[Block] = []
    for row in rows:
        try:
            blk = _block_from_data(row.data)
        except Exception:
            continue
        if day and not _on_day(blk, day):
            continue
        # Handle date range filtering and repeat expansion
        bk = blk.block_kind
        if bk == "event" and blk.repeat:
            # Expand repeat occurrences
            if blk.start and blk.end:
                today = date.today()
                occs = _occurrences(
                    tuple(blk.repeat.weekdays), blk.start, blk.end,
                    blk.day, blk.repeat.until, today or date.today(),
                    RECURRING_HORIZON_DAYS
                )
                for occ_day, occ_start, occ_end in occs:
                    if from_ and occ_day < from_:
                        continue
                    if to and occ_day > to:
                        continue
                    # Create a synthetic occurrence block with occurrence_date
                    occ_block = blk.model_copy(deep=True)
                    occ_block.day = occ_day
                    occ_block.start = occ_start
                    occ_block.end = occ_end
                    occ_block.id = f"{row.id}:{occ_day.isoformat()}"
                    items.append(occ_block)
            else:
                # All-day event with repeat
                if from_ and blk.day < from_:
                    continue
                if to and blk.day > to:
                    continue
                items.append(blk)
        elif bk == "task" and blk.repeat:
            # Expand repeating tasks
            if blk.start and blk.end:
                today = date.today()
                occs = _occurrences(
                    tuple(blk.repeat.weekdays), blk.start, blk.end,
                    blk.day, blk.repeat.until, today or date.today(),
                    RECURRING_HORIZON_DAYS
                )
                for occ_day, occ_start, occ_end in occs:
                    if from_ and occ_day < from_:
                        continue
                    if to and occ_day > to:
                        continue
                    occ_block = blk.model_copy(deep=True)
                    occ_block.day = occ_day
                    occ_block.start = occ_start
                    occ_block.end = occ_end
                    occ_block.id = f"{row.id}:{occ_day.isoformat()}"
                    items.append(occ_block)
            else:
                items.append(blk)
        else:
            # Non-repeating blocks
            if from_ and blk.day < from_:
                continue
            if to and blk.day > to:
                continue
            items.append(blk)

    version = await _get_version(session, user.user_id)
    return BlockListResponse(items=items, version=version)


@router.get("/blocks/{block_id}", response_model=BlockResponse)
async def get_block(
    block_id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """Get one block by id."""
    row = await session.get(CalendarBlock, block_id)
    if row is None or row.user_id != user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Block not found")
    block = _block_from_data(row.data)
    version = await _get_version(session, user.user_id)
    return BlockResponse(id=block_id, version=version, block=block)


@router.patch("/blocks/{block_id}", response_model=BlockResponse)
async def update_block(
    block_id: str,
    req: UpdateBlockReq,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """Update a block's full state."""
    row = await session.get(CalendarBlock, block_id)
    if row is None or row.user_id != user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Block not found")

    # P0 #8: path id wins (ownership)
    block = req.block
    block.id = block_id

    from ..deps import local_now
    today = local_now(user.timezone).date()
    store = SqlStore(session, user.user_id, today=today)
    result = await update_item(store, block, Origin(source="manual"))

    from agentv2.contracts.results import Rejected, Applied
    if isinstance(result, Rejected):
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"violations": [v.model_dump() for v in result.violations]},
        )

    assert isinstance(result, Applied), "Expected Applied result"
    await session.commit()
    return BlockResponse(
        id=block_id,
        version=result.version,
        block=block,
        audit_id=result.audit_id,
        displaced_goals=result.displaced_goals
    )


@router.delete("/blocks/{block_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_block(
    block_id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """Delete a block."""
    row = await session.get(CalendarBlock, block_id)
    if row is None or row.user_id != user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Block not found")

    from ..deps import local_now
    today = local_now(user.timezone).date()
    store = SqlStore(session, user.user_id, today=today)
    result = await delete_item(store, block_id, Origin(source="manual"))

    from agentv2.contracts.results import Rejected, Applied
    if isinstance(result, Rejected):
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"violations": [v.model_dump() for v in result.violations]},
        )

    assert isinstance(result, Applied), "Expected Applied result"
    await session.commit()
    # Note: 204 No Content doesn't return a body, so audit_id and displaced_goals are lost.
    # If the client needs them, we should return 200 with a body.


# ---------------------------------------------------------------------------
# generic undo
# ---------------------------------------------------------------------------

class UndoResponse(BaseModel):
    version: int
    undone: bool


@router.post("/audit/{audit_id}/undo", response_model=UndoResponse)
async def undo_audit(
    audit_id: str,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """Generic undo for any audit entry."""
    from ..deps import local_now
    from ..models import AuditEntry

    # Verify the audit entry belongs to the user
    row = await session.get(AuditEntry, audit_id)
    if row is None or row.user_id != user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit entry not found")

    if row.payload and row.payload.get("undone"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already undone")

    today = local_now(user.timezone).date()
    store = SqlStore(session, user.user_id, today=today)

    loaded = await store.load_audit(audit_id)
    if loaded is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audit entry not found or not revertable")

    cs, applied_indices, undone_flag = loaded
    if undone_flag:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already undone")

    # Revert applied changes in reverse order
    for idx in reversed(applied_indices):
        if idx < len(cs.changes):
            await store.revert(cs.changes[idx])

    # Mark as undone and bump version
    await store.mark_undone(audit_id)
    version = await store.bump_version()
    await session.commit()

    return UndoResponse(version=version, undone=True)


# ---------------------------------------------------------------------------
# version — accessible at /state/version
# ---------------------------------------------------------------------------

@router.get("/state/version", response_model=VersionResponse, include_in_schema=False)
async def get_version(
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
):
    """Return the current board version."""
    version = await _get_version(session, user.user_id)
    return VersionResponse(version=version)
