"""One conversational turn — the four stages, and the outcome they produce.

It is a decision tree, not a graph: four stages with one branch. A state machine would add checkpointing semantics to a turn that has no
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
from .prompts import KIND_ADD_GOAL, KIND_PLAN_DAY, MAX_QUESTIONS_PER_ROUND, PROPOSE_NOW_PROMPT, REFINE_PROMPT, assemble_system
from .questions import drop_answered_by_profile, filter_repeats
from .safety import signals_crisis
from .tools_block import (
    Proposal,
    extract_clarifying_questions,
    strip_question_list,
    parse_proposals,
    split_prose_and_tools,
)

#: `(system, user) -> the model's text`. The route passes a callable in rather than
#: this package importing a model client, which is also what makes the whole turn testable with a fake.
TextComplete = Callable[[str, str], Awaitable[str]]

Outcome = Literal["prose", "clarify", "proposals"]

#: Clarifying rounds one conversation may have before the coach must propose. Generous but finite
#: (CLAUDE.md principle 6): a vague goal can never become an endless questionnaire.
MAX_INTERVIEW_ROUNDS = 6
#: The question asked when the model asked none and a question is wanted.
FALLBACK_QUESTION = "What would make this plan wrong — what should I know before I build it?"



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
    #: Questions the model wrote that were dropped as repeats or as already answered by the profile.
    dropped_questions: list[str] = field(default_factory=list)
    #: True when the message signalled a crisis: no plan, no question card, only the reply.
    crisis: bool = False
    #: True when `prose` replaced what was streamed (a question list that was all repeats); the stream
    #: then shows `prose` instead of the first reply.
    replaced: bool = False


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
    asked: list[str] | None = None,
    rounds_asked: int = 0,
    profile_answers: set[str] | None = None,
) -> Turn:
    """Run the four stages.

    `on_delta` is awaited per chunk of prose so the caller can frame it as SSE as
    it arrives. It is optional: without it the turn runs silently and returns the
    whole reply, which is what `/chat/plan` wants.

    `asked` is every question already asked in this conversation and `rounds_asked` how many clarifying
    rounds there were; `profile_answers` names the profile topics the user already answered
    (`questions.PROFILE_TOPICS`). Together they keep the interview from repeating itself.
    """
    asked = list(asked or [])
    system = assemble_system(
        proactive_propose=proactive_propose,
        clarify=clarify,
        auto_answer=auto_answer,
        scoped_kind=scoped_kind,
        context=context,
        asked=asked,
    )

    crisis = signals_crisis(message)
    prose, block = await _generate(
        complete=complete, system=system, message=message, on_delta=on_delta
    )
    if crisis:
        # Whatever the model wrote, a person signalling crisis gets the reply and nothing pushed at them.
        return Turn(outcome="prose", prose=prose, crisis=True)
    proposals = parse_proposals(block)

    # ── refine: prose arrived, no block, but a proposal was wanted ──────────
    refined = False
    if (
        not proposals
        and auto_answer
        and not clarify
        and scoped_kind not in ("general", KIND_PLAN_DAY)
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
    # Day planning answers with slots, never with an interview (its prompt asks at most one question).
    wants_questions = (clarify or not auto_answer) and scoped_kind not in ("general", KIND_PLAN_DAY)
    questions: list[dict] = []
    dropped: list[str] = []
    replaced = False
    if wants_questions and not proposals:
        found = extract_clarifying_questions(prose)
        fresh = drop_answered_by_profile(filter_repeats(found, asked), profile_answers or set())
        dropped = [q["question"] for q in found if q not in fresh]
        out_of_rounds = rounds_asked >= MAX_INTERVIEW_ROUNDS and not clarify
        if fresh and not out_of_rounds:
            questions = enrich(fresh[:MAX_QUESTIONS_PER_ROUND])
            # The card shows the questions one at a time, so the numbered list is not repeated above it.
            prose = strip_question_list(prose)
        elif scoped_kind == KIND_ADD_GOAL and (found or out_of_rounds or not clarify):
            # Everything the model wanted to ask was already asked (or answered by the profile), or the
            # interview has had its rounds: no second card of the same questions. Assume and propose.
            follow_up = await complete(system, f"{message}\n\n---\n{PROPOSE_NOW_PROMPT}")
            extra_prose, extra_block = split_prose_and_tools(follow_up)
            proposals = parse_proposals(extra_block)
            refined = replaced = True
            prose = extra_prose.strip() or strip_question_list(prose)
        elif found:
            # Only repeats, outside add-goal: the reply stands, without a second card of old questions.
            prose = strip_question_list(prose)
            replaced = True
        else:
            # A model that asked nothing still leaves the user something to act on: one question about the
            # plan itself, unless that too was already asked.
            fallback = [{"id": "q1", "question": FALLBACK_QUESTION, "options": []}]
            questions = enrich(filter_repeats(fallback, asked))

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
            dropped_questions=dropped,
        )

    if proposals:
        return Turn(outcome="proposals", prose=prose, proposals=proposals, refined=refined, dropped_questions=dropped, replaced=replaced)

    return Turn(outcome="prose", prose=prose, refined=refined, dropped_questions=dropped, replaced=replaced)


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
        # The whole reply is already in hand, so there is nothing still arriving to hold back: with a
        # block, show only the prose; without one, show it all. (Holding back the tail here once cut
        # every reply off ten characters early.)
        visible, _ = split_prose_and_tools(full)
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
    asked: list[str] | None = None,
    rounds_asked: int = 0,
    profile_answers: set[str] | None = None,
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
        asked=asked,
        rounds_asked=rounds_asked,
        profile_answers=profile_answers,
    )

    if turn.outcome == "clarify" or turn.replaced:
        # The prose was trimmed or replaced; the streamed copy still has the question list.
        if turn.prose.strip():
            yield ("delta", turn.prose)
    else:
        for chunk in deltas:
            yield ("delta", chunk)

    if turn.outcome == "clarify":
        yield ("needs_clarification", turn)
    elif turn.outcome == "proposals":
        yield ("tools", turn.proposals)

    yield ("done", turn)
