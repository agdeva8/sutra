"""What the validator and gateway hand back."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Violation(_Strict):
    """One broken hard rule. `rule` is machine-readable; the fixer will be handed these."""

    rule: str
    change_index: int
    message: str


class Proposal(_Strict):
    change_index: int
    reason: str


class Applied(_Strict):
    #: Goals whose planned (tentative) time a new fixed block displaced. The caller replans them.
    displaced_goals: list[str] = []
    applied: list[int]
    proposed: list[Proposal]
    audit_id: str


class Rejected(_Strict):
    violations: list[Violation]
