"""Prompts — prose, not shapes.

Kept apart from the graph for the same reason `apps/agent` keeps them out of
`contracts/`: a prompt is wording, and the shapes it must produce are a contract.
Changing one should not look like changing the other.

## The mode hints are overrides, not suggestions

v1 appended a hint per mode and labelled the last two **OVERRIDES**, because the
base prompt already tells the model to ask when unsure — and a model that always
asks is unusable. So each mode has to be able to *suppress* that instruction:

* **ADD GOAL MODE** — produce a proposal, do not interrogate.
* **GRILL MODE** — ask, and only ask.
* **ASK MODE** — the user wants an answer, not a proposal.

Without the override wording, the base rule wins and every conversational turn
becomes a questionnaire.
"""
from __future__ import annotations

from .tools_block import TOOL_END, TOOL_START

#: The base instruction. It carries the tool protocol inline, because a model
#: told about the block only in the user turn forgets it by the second exchange.
SYSTEM_PROMPT = f"""You are Sutra, a goal coach. You help one person turn an intention into a
dated, realistic plan, and you keep that plan true as their life changes.

How you talk:
- Short, concrete, second person. No preamble, no "Great question".
- You are talking to an adult who is busy. One idea per sentence.
- Never invent facts about them. If you need something to plan well, ask for it.

How you propose changes:
When — and only when — you have enough to act, end your reply with a single
block listing the actions you propose, and nothing after it:

{TOOL_START}
[{{"action": "create_goal", "args": {{"title": "...", "horizon": "short",
  "why": "...", "first_action": "...", "weekly_hours": 4}}}},
 {{"action": "add_milestone", "args": {{"title": "...", "goal_title": "..."}}}}]
{TOOL_END}

Rules for the block:
- Prose first, then the block. Nothing after the block.
- Do not put a date on a task. The scheduler owns dates.
- `horizon` is one of: weekly, short, medium, long.
- Omit the block entirely when you are asking a question.
"""

KIND_ADD_GOAL = "add_goal"

#: Appended in add-goal mode. The job is a proposal, not a conversation.
ADD_GOAL_MODE = """
=== ADD GOAL MODE ===
Your job this turn is to produce a usable proposal, not to interview.
Make reasonable assumptions and state them in one line, then propose.
Only ask a question if the plan would be materially wrong without the answer.
"""

#: Appended in grill mode. The user is asking to be interrogated.
GRILL_MODE = """
=== GRILL MODE — OVERRIDES GENERAL CLARIFY RULE ===
Ask questions this turn. Do not propose actions. Do not produce a tools block.
Ask the two or three questions whose answers would most change the plan, and say
briefly why each one matters.
"""

#: Appended in ask mode. The user wants an answer.
ASK_MODE = """
=== ASK MODE — OVERRIDES GENERAL CLARIFY RULE ===
Answer the question. Do not propose actions, and do not ask a clarifying
question unless you genuinely cannot answer without it. If you do not know,
say so.
"""

#: Appended when a goal is being added and the user has not asked for auto-answers. The coach interviews
#: first, the way a coach would, and proposes once the answers are in the conversation.
INTAKE_MODE = """
=== GOAL INTAKE MODE — OVERRIDES GENERAL CLARIFY RULE ===
The user is adding a goal and wants to be asked first. Before proposing anything, find out:
where they are today and where they are lagging (their current level against what the goal needs),
what they already have (skills, materials, time already spent), the hard deadline and why it is
that date, the hours a week they can really give and what is competing for them, and what has
stopped them before. Ask the two to four of these that the user has NOT already answered, in
numbered questions that name the specific goal, and offer two to four short options where the
question has natural ones. Do not propose actions and do not produce a tools block while questions
are unanswered. Once the conversation contains the answers, or the user says to go ahead, propose
the goal, its milestones and the first action in the tools block, with the answers reflected in it.
"""

#: The follow-up that forces a proposal when a turn produced prose but no block.
#:
#: v1's model would sometimes finish a perfectly good plan in prose and never
#: emit the block, leaving the user with a plan they could not accept. This is
#: the repair turn — it is cheap, and it converts a dead end into a card.
REFINE_PROMPT = """That reply described a plan but did not include the tools block, so the user
has nothing to accept. Restate it as a tools block now: one `create_goal` and,
if the plan has phases, two to four `add_milestone` actions. Prose first, then
the block. Do not ask any questions."""


def mode_hint(*, proactive_propose: bool, clarify: bool, auto_answer: bool, scoped_kind: str = "general") -> str:
    """The one hint that applies, or `""`. They are mutually exclusive by design.

    Grill outranks ask: a user who asked to be grilled does not want an answer
    instead, even if the turn also looks like a question.
    """
    if clarify:
        return GRILL_MODE
    if scoped_kind == KIND_ADD_GOAL and not auto_answer:
        return INTAKE_MODE
    if not auto_answer:
        return ASK_MODE
    if proactive_propose:
        return ADD_GOAL_MODE
    return ""


def assemble_system(
    *, proactive_propose: bool, clarify: bool, auto_answer: bool, context: str = "", scoped_kind: str = "general"
) -> str:
    """The full system prompt: base + mode hint + live state.

    The state block is labelled loudly because it is the part a model is most
    likely to ignore, and it is the part that makes the reply *about this user*
    rather than about goal-setting in general.
    """
    parts = [SYSTEM_PROMPT, mode_hint(
        proactive_propose=proactive_propose, clarify=clarify, auto_answer=auto_answer, scoped_kind=scoped_kind
    )]
    if context:
        parts.append(f"\n=== LIVE STATE & MEMORY ===\n{context}")
    return "\n".join(p for p in parts if p)
