"""The gateway's only view of persistence.

A protocol so `agentv2` never imports a database driver: the SQL implementation
is written in `apps/api` (which imports this package, not the other way round),
and `InMemoryStore` below backs the demo and the tests.
"""
from __future__ import annotations

from typing import Protocol

from ..core.context import Context
from ..contracts import Change, ChangeSet, Origin, Proposal


class Store(Protocol):
    async def context(self) -> Context: ...

    def transaction(self):
        """An async context manager: everything written inside commits or rolls back together."""
        ...

    async def write(self, change: Change, origin: Origin) -> None: ...

    async def add_proposal(self, change: Change, reason: str, origin: Origin) -> str: ...

    async def write_audit(self, cs: ChangeSet, applied: list[int], proposed: list[Proposal]) -> str: ...

    async def bump_version(self) -> int:
        """Increment the board version and return the new value. Called inside the transaction."""
        ...

    async def extend_recurring(self, today) -> int:
        """Lay out any recurring commitment that has not been laid out up to the horizon. Returns blocks added."""
        ...

    async def remove_blocks(self, block_ids: list[str]) -> None:
        """Delete tentative blocks (the agent's own planned time) that a fixed block displaced."""
        ...

    async def load_audit(self, audit_id: str) -> tuple[ChangeSet, list[int], bool] | None:
        """(change set, applied indexes, already undone), or None if there is no such audit row."""
        ...

    async def revert(self, change: Change) -> None: ...

    async def mark_undone(self, audit_id: str) -> None: ...

    async def log_reject(self, cs: ChangeSet, violations: list) -> None: ...
