"""Pure functions over already-loaded data.

**No imports from `store/`, `db`, `wire`, or FastAPI.** These take plain dicts
and return plain dicts, exactly as `agentv2/core/` does, and for the same
reason: the logic is the part worth testing, and it should be testable without a
database.

Each module here is a port of a v1 file that was already pure, so the port is
mechanical and the copy is preserved verbatim — these strings are user-visible
and the same sentence must render whether it is read from `/state` or typed into
a chat prefill.
"""
