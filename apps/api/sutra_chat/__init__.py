"""The chat subsystem — its own package, on purpose.

## Why a separate package

`apps/agent` owns the *planning* graph. It has no chat graph and, per the HLD's
package boundary, it should not grow one: `/chat/stream` is a product surface
that happens to use a model, not a stage of the planner.

So this lives beside `sutra_api` rather than inside it, and it imports nothing
from the service. That keeps the dependency direction readable:

    sutra_api  ──imports──▶  sutra_chat
    sutra_api  ──imports──▶  app (apps/agent)
    sutra_chat ──imports──▶  nothing of ours

Nothing here reaches for the database, the request, or the settings object. The
routes hand it a prompt, a message, and a `complete` function; it hands back
prose and proposals. That is what makes every routing decision in it testable
without a server.

Unlike the planner, this is **not** a LangGraph graph. Four stages with one
branch is a decision tree, not a state machine — and a second graph runtime would
be a second set of checkpointing semantics to reason about for no gain. The
stages keep v1's names (`generate`, `ask`, `refine`, `finalize`) so the two can
be read side by side.
"""
