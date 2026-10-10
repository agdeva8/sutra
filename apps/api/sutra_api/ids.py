"""Row ids — `<prefix>_<12 hex>`.

Ported verbatim from v1's `api/lib/ids.ts`, which is the whole id policy in four
lines:

    export function newId(prefix: string): string {
      const hex = randomUUID().replace(/-/g, '').slice(0, 12)
      return `${prefix}_${hex}`
    }

Ids are opaque `text` columns, never uuid/int — v1's Mongo→Postgres ETL relied on
that to preserve ids 1:1, and the prefixes keep a raw row readable in a log.

One asymmetry carried over deliberately: `plan-items` in v1's Next.js route used
20 hex chars where everything else used 12. Ids are opaque, so both work; this
module emits 12 everywhere, and nothing may assume a fixed length.
"""
from __future__ import annotations

import secrets
import uuid

#: The canonical prefixes. Not a closed set — v1 emitted several more for tables
#: that no longer exist (`commit_` went with the dropped `commitments` table).
PREFIXES = {
    "audit": "audit",      # audit_log
    "block": "block",      # timetable_blocks
    "blocker": "blk",      # blockers
    "change": "chg",       # plan_change_ledger
    "conversation": "conv",  # conversations (usually deterministic, see below)
    "goal": "goal",
    "memory": "mem",
    "message": "msg",
    "milestone": "mile",
    "plan_item": "pi",
    "proposal": "prop",
    "reject": "prej",      # plan_rejects
    "source": "src",
    "user": "user",
    "user_fact": "fact",
}


def new_id(prefix: str) -> str:
    """`new_id("goal")` -> `goal_9f2c1ab4de07`."""
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def new_guest_user_id() -> str:
    """A guest's identity: `user_guest_<12 hex>` (48 bits, so collision-safe).

    v1 minted this with `crypto.randomBytes(6)`; `secrets.token_hex(6)` is the
    same thing without the `random`-module footgun.
    """
    return f"user_guest_{secrets.token_hex(6)}"


def conversation_id(kind: str, ref_id: str = "") -> str:
    """Deterministic conversation ids — v1's bucketing rule, kept exactly.

    `conv_general_<user_id>` is the default bucket; anything else is
    `conv_<kind>_<refId>`. Deterministic because the id *is* the bucket key: a
    reload must land in the same conversation, and a second plan for the same
    goal must not fork a new thread.
    """
    return f"conv_{kind}_{ref_id}" if ref_id else f"conv_{kind}"
