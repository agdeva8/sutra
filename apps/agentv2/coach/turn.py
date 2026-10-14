"""One conversational turn — the four stages, and the outcome they produce.

v1 expressed this as a LangGraph graph (`lib/chat/ops-graph.ts`). It is a
decision tree here, because that is what it always was: four stages with one
branch. A state machine would add checkpointing semantics to a turn that has no
interrupt and no resume.

The stage names are v1's, so the two can be read side by side:

| stage | v1 node | job |
|---|---|---|
| `generate` | `n_generate` | stream prose, split off the tools block |
| `ask` | `n_ask` | dig clarifying questions out of the prose |
| `refine` | `n_refine` | prose arrived but no block — ask for the block once |
| `finalize` | `n_finalize` | apply the mode filters, decide the outcome |

## The one thing to understand

**`auto_answer` defaults to true.** The user has to opt *into* being asked a
question. v1 made that call and it is the right one: a coach that interrogates
before it ever proposes is a form, and the default is what keeps the common case
— "turn this sentence into a plan" — a single round trip.

Grill mode and ask mode exist to override it, which is why the mode hints are
labelled *OVERRIDES* in `prompts.py`.
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Literal

from .clarify_options import enrich
from .prompts import REFINE_PROMPT, assemble_system
from .tools_block import (
    Proposal,
    extract_clarifying_questions,
    parse_proposals,
    split_prose_and_tools,
)

#: `(system, user) -> the model's text`. The agent's `CompleteFn` is not used
#: directly because this package must not import `apps/agent` — the route passes
#: a callable in, which is also what makes the whole turn testable with a fake.
TextComplete = Callable[[str, str], Awaitable[str]]

Outcome = Literal["prose", "clarify", "proposals"]

#: How much of the sentinel to hold back while streaming.
#:
#: Without this, the first characters of `[[TOOLS]]` reach the user as prose
#: before the parser notices the block — and `[[TO` flashing in the reply is the
#: most common way this protocol looks broken.
_HOLDBACK = len("[[TOOLS]]")


@dataclass
class Turn:
    """What one turn produced."""

    outcome: Outcome
    prose: str = ""
    proposals: list[Proposal] = field(default_factory=list)
    questions: list[dict] = field(default_factory=list)
    needs_clarification: str = ""
    provider: str = ""
    #: True when the `refine` stage had to run — i.e. the first reply was prose
    #: with no block. Worth surfacing: a rate that climbs means the prompt is
    #: drifting away from emitting the block.
    refined: bool = False


async def run_turn(
    *,
    complete: TextComplete,
    message: str,
    context: str = "",
    auto_answer: bool = True,
    clarify: bool = False,
    proactive_propose: bool = False,
    scoped_kind: str = "general",
    on_delta: Callable[[str], Awaitable[None]] | None = None,
) -> Turn:
    """Run the four stages.

    `on_delta` is awaited per chunk of prose so the caller can frame it as SSE as
    it arrives. It is optional: without it the turn runs silently and returns the
    whole reply, which is what `/chat/plan` wants.
    """
    system = assemble_system(
        proactive_propose=proactive_propose,
        clarify=clarify,
        auto_answer=auto_answer,
        scoped_kind=scoped_kind,
        context=context,
    )

    prose, block = await _generate(
        complete=complete, system=system, message=message, on_delta=on_delta
    )
    proposals = parse_proposals(block)

    # ── refine: prose arrived, no block, but a proposal was wanted ──────────
    refined = False
    if (
        not proposals
        and auto_answer
        and not clarify
        and scoped_kind != "general"
        and prose.strip()
        and not block
    ):
        refined = True
        follow_up = await complete(system, REFINE_PROMPT)
        extra_prose, extra_block = split_prose_and_tools(follow_up)
        proposals = parse_proposals(extra_block)
        if proposals:
            if on_delta is not None and extra_prose.strip():
                await on_delta(f"\n\n{extra_prose.strip()}")
            prose = f"{prose}\n\n{extra_prose.strip()}".strip()

    # ── ask: questions, when the user asked for them ────────────────────────
    wants_questions = (clarify or not auto_answer) and scoped_kind != "general"
    questions: list[dict] = []
    if wants_questions and not proposals:
        found = extract_clarifying_questions(prose)
        if found:
            questions = enrich(found)
        else:
            # A model that refuses to ask still needs to produce something the
            # user can act on, so fall back to a question about the goal itself
            # rather than returning an empty clarifying turn — which would leave
            # the client with a prompt and no question under it.
            questions = enrich(
                [
                    {
                        "id": "q1",
                        "question": (
                            "What would make this plan wrong — what should I know "
                            "before I build it?"
                        ),
                        "options": [],
                    }
                ]
            )

    # ── finalize ────────────────────────────────────────────────────────────
    if questions:
        return Turn(
            outcome="clarify",
            prose=prose,
            questions=questions,
            needs_clarification=(
                "I need a few more specifics before I can build a tailored plan:"
                if clarify
                else "A few details will materially change the plan:"
            ),
            refined=refined,
        )

    if proposals:
        return Turn(outcome="proposals", prose=prose, proposals=proposals, refined=refined)

    return Turn(outcome="prose", prose=prose, refined=refined)


async def _generate(
    *,
    complete: TextComplete,
    system: str,
    message: str,
    on_delta: Callable[[str], Awaitable[None]] | None,
) -> tuple[str, str]:
    """One model call, prose streamed as it arrives.

    The sentinel is held back while streaming so a partial `[[TOOLS]]` never
    reaches the client as text — see `_HOLDBACK`.
    """
    full = await complete(system, message)

    if on_delta is not None and full:
        prose_part, _ = split_prose_and_tools(full)
        # With a block, stream only the prose. Without one, hold back the last
        # few characters in case the block is still arriving.
        visible = prose_part if prose_part != full else full[: max(0, len(full) - _HOLDBACK)]
        if visible:
            await on_delta(visible)

    return split_prose_and_tools(full)


async def stream_turn(
    *,
    complete: TextComplete,
    message: str,
    context: str = "",
    auto_answer: bool = True,
    clarify: bool = False,
    proactive_propose: bool = False,
    scoped_kind: str = "general",
) -> AsyncIterator[tuple[str, object]]:
    """`(event, payload)` pairs for an SSE route, in the order they occur.

    Events: `delta` (str), `tools` (list[Proposal]), `needs_clarification`
    (the Turn), `done` (the Turn). Keeping the framing in the route and the
    ordering here means the sequence is testable without a socket.
    """
    deltas: list[str] = []

    async def _collect(chunk: str) -> None:
        deltas.append(chunk)

    turn = await run_turn(
        complete=complete,
        message=message,
        context=context,
        auto_answer=auto_answer,
        clarify=clarify,
        proactive_propose=proactive_propose,
        scoped_kind=scoped_kind,
        on_delta=_collect,
    )

    for chunk in deltas:
        yield ("delta", chunk)

    if turn.outcome == "clarify":
        yield ("needs_clarification", turn)
    elif turn.outcome == "proposals":
        yield ("tools", turn.proposals)

    yield ("done", turn)
