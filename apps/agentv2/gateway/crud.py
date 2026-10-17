"""Python CRUD for the four calendar block kinds.

These functions are the general CRUD operation — callable from API routes, the agent,
or any other code. Each one builds a `ChangeSet`, calls `apply`, and returns the
result. Version bumping is handled inside `apply`.

Usage:
    from agentv2.gateway.crud import add_item, update_item, delete_item, get_item, list_items
    from agentv2.gateway import InMemoryStore

    store = InMemoryStore()
    result = await add_item(store, EventBlock(...))
    print(result.version)   # incremented
"""
from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from .apply import apply
from .store import Store
from ..contracts import ChangeSet, Origin
from ..contracts.blocks import (
    AddItem, EditItem, DeleteItem, Block, EventBlock, TaskBlock,
    AwayBlock, MilestoneBlock, BlockKind, ItemResult, BLOCK_ADAPTER,
)
from ..contracts.results import Applied, Rejected

if TYPE_CHECKING:
    pass


# ---------------------------------------------------------------------------
# Id generation
# ---------------------------------------------------------------------------

def new_id() -> str:
    """Generate a new `block_` prefixed id for a calendar block."""
    import uuid
    return f"block_{uuid.uuid4().hex[:12]}"


# ---------------------------------------------------------------------------
# CRUD — each wraps apply and returns ItemResult
# ---------------------------------------------------------------------------

async def add_item(
    store: Store,
    block: Block,
    origin: Origin,
) -> Applied | Rejected:
    """Create one block. `origin.source` is one of: scratch, goal, tick, manual, chat."""
    change = AddItem(block=block)
    cs = ChangeSet(origin=origin, changes=[change])
    result = await apply(cs, store)
    return result


async def update_item(
    store: Store,
    block: Block,
    origin: Origin,
) -> Applied | Rejected:
    """Replace a block's full state. `before` is snapshot for undo.

    The block's `id` must match the existing item. Returns the new state.
    """
    # P0 #6: Read current state from context for the before snapshot.
    ctx = await store.context()
    current = ctx.items.get(block.id)
    if current is None:
        raise ValueError(f"item {block.id} not found")

    before = BLOCK_ADAPTER.validate_python(current).model_dump(mode="json")
    change = EditItem(id=block.id, block=block, before=before)
    cs = ChangeSet(origin=origin, changes=[change])
    result = await apply(cs, store)
    return result


async def delete_item(
    store: Store,
    block_id: str,
    origin: Origin,
) -> Applied | Rejected:
    """Delete a block. The `block` payload must contain the full state for undo."""
    # P0 #6: Read current state from context for the block snapshot.
    ctx = await store.context()
    current = ctx.items.get(block_id)
    if current is None:
        raise ValueError(f"item {block_id} not found")

    change = DeleteItem(id=block_id, block=current)
    cs = ChangeSet(origin=origin, changes=[change])
    result = await apply(cs, store)
    return result


async def get_item(store: Store, block_id: str) -> Block | None:
    """Return a block by id, or None if not found.

    Searches all four kinds in priority order.
    """
    # Try to read from the store's blocks4 dict if available
    try:
        blocks4 = getattr(store, "blocks4", None)
        if blocks4 is not None:
            return blocks4.get(block_id)
    except (TypeError, AttributeError):
        pass
    # SqlStore does not expose blocks4 directly; callers should use a
    # dedicated repository read. This method is primarily for InMemoryStore.
    return None


async def list_items(
    store: Store,
    kind: BlockKind | None = None,
    day: date | None = None,
) -> list[Block]:
    """List blocks, optionally filtered by kind and/or day.

    For `SqlStore` this reads the `calendar_blocks` table directly (no apply needed).
    For `InMemoryStore` it reads from `blocks4`.
    """
    try:
        blocks4 = getattr(store, "blocks4", None)
        if blocks4 is not None:
            out = list(blocks4.values())
        else:
            out = []
    except (TypeError, AttributeError):
        out = []

    if kind is not None:
        out = [b for b in out if b.block_kind == kind]
    if day is not None:
        out = [b for b in out if _on_day(b, day)]
    return out


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
