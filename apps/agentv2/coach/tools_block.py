"""The `[[TOOLS]]…[[/TOOLS]]` protocol — how a model asks to change the plan.

Ported verbatim from v1's `lib/emergent/llm.ts`, which was itself a port of the
original Python backend's `parse_proposals`.

**Why a text block at all.** The model returns prose *and* structured actions in
one response, and the frame that carries proposals is separate from the frame
that carries prose. So the reply has to be split. A sentinel block is cruder than
native tool-calling, and it survives providers that do not implement it — which
was v1's reason and is still a good one, because the same code path has to work
against the offline stub.

The parsing is **deliberately forgiving**, and each leniency answers a failure
that actually happened:

* The array may be wrapped in prose — take the first `[` to the last `]`.
* A bare object may be returned where an array was asked for — wrap it.
* A `create_goal` whose title reads like an instruction to destroy something is
  **dropped**, because a model that misreads "drop the job goal" as a *title*
  would otherwise create a goal called "drop the job goal".
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: The sentinels. v1's exact strings — a change here is a protocol change.
TOOL_START = "[[TOOLS]]"
TOOL_END = "[[/TOOLS]]"

#: A `create_goal` intent that is really a *drop* instruction in disguise.
#:
#: "drop the job goal" parsed as a title produces a goal literally called that.
#: v1 shipped this bug; the guard is the fix.
_DROP_INTENT = re.compile(
    r"^(drop|delete|remove|pause|stop|trash|archive|abandon|kill)\b", re.IGNORECASE
)


@dataclass
class Proposal:
    """A pending action. `args` is free-form — the action names its own shape."""

    id: str
    action: str
    args: dict = field(default_factory=dict)
    status: str = "pending"

    def as_wire(self) -> dict:
        return {
            "id": self.id,
            "action": self.action,
            "args": self.args,
            "status": self.status,
        }


def new_proposal_id() -> str:
    return f"prop_{uuid.uuid4().hex[:12]}"


def looks_like_drop_intent(title: str) -> bool:
    return bool(_DROP_INTENT.match((title or "").strip()))


def split_prose_and_tools(full: str) -> tuple[str, str]:
    """`(prose, tools_block)`. The block is returned raw, or `""`.

    An unterminated block is treated as prose that happens to contain the
    sentinel — a model cut off mid-block has produced no usable action, and
    guessing at one is worse than showing the text.
    """
    start = full.find(TOOL_START)
    if start == -1:
        return full, ""
    end = full.find(TOOL_END, start)
    if end == -1:
        return full, ""
    return full[:start], full[start : end + len(TOOL_END)]


def parse_proposals(block: str) -> list[Proposal]:
    """Actions from a tools block. Never raises — a bad block is no block.

    Returning `[]` for an unparseable block is the right failure: the prose is
    still shown, the user sees the coach's reply, and the only loss is a proposal
    they did not get to confirm. Raising would lose the reply too.
    """
    if not block:
        return []

    body = block
    if body.startswith(TOOL_START):
        body = body[len(TOOL_START) :]
    if body.endswith(TOOL_END):
        body = body[: -len(TOOL_END)]

    start = body.find("[")
    end = body.rfind("]")
    if start == -1 or end == -1 or end < start:
        # A bare object where an array was asked for.
        start = body.find("{")
        end = body.rfind("}")
        if start == -1 or end == -1 or end < start:
            return []
    raw = body[start : end + 1]

    try:
        parsed = json.loads(raw)
    except ValueError:
        return []

    if isinstance(parsed, dict):
        parsed = [parsed]
    if not isinstance(parsed, list):
        return []

    out: list[Proposal] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        action = item.get("action")
        if not isinstance(action, str) or not action:
            continue
        args = item.get("args")
        if not isinstance(args, dict):
            # A model may put the fields at the top level instead of under
            # `args`. Both shapes appear in the wild, and the executor reads
            # `args`, so normalise here rather than teaching it two layouts.
            args = {
                k: v for k, v in item.items() if k not in ("action", "id", "status")
            }
        if action == "create_goal" and looks_like_drop_intent(str(args.get("title") or "")):
            # The guard: a drop instruction misread as a title.
            continue
        out.append(
            Proposal(
                id=str(item.get("id") or new_proposal_id()),
                action=action,
                args=args,
                status=str(item.get("status") or "pending"),
            )
        )
    return keep_one_create_goal(out)


def keep_one_create_goal(proposals: list[Proposal]) -> list[Proposal]:
    """At most one `create_goal` in a reply: the last, which is the most refined.

    A model asked to re-propose (a repeat, or a refined copy beside the original) can return two
    goal cards in one block. The client confirms a plan in one batch, so both would create a goal.
    Keeping the last card — the one written after any revision — and dropping the earlier ones is
    the rule at the source; `AddGoalDialog.confirm` and the `/tools/confirm` batch enforce the same
    rule for prompts already in flight.

    Milestones attach to a goal by **title** (`args.goal_title`), so milestones aimed at a dropped
    card are re-pointed at the kept one. Returning a new list rather than mutating keeps the
    parser's output the model produced except for this one normalisation.
    """
    goals = [p for p in proposals if p.action == "create_goal"]
    if len(goals) < 2:
        return proposals

    kept = goals[-1]
    dropped_titles = {
        str(p.args.get("title") or "").strip() for p in goals[:-1]
    } - {""}
    kept_title = str(kept.args.get("title") or "").strip()
    logger.warning(
        "Coach reply carried %d create_goal proposals; kept %s and dropped %s",
        len(goals),
        kept.id,
        [p.id for p in goals[:-1]],
    )

    out: list[Proposal] = []
    for proposal in proposals:
        if proposal.action == "create_goal" and proposal is not kept:
            continue
        if (
            proposal.action == "add_milestone"
            and kept_title
            and str(proposal.args.get("goal_title") or "").strip() in dropped_titles
        ):
            proposal = Proposal(
                id=proposal.id,
                action=proposal.action,
                args={**proposal.args, "goal_title": kept_title},
                status=proposal.status,
            )
        out.append(proposal)
    return out


def has_questions(text: str) -> bool:
    return bool(extract_clarifying_questions(text))


#: The lettered choices a model writes inline: "(a) ...", "(b) ...".
INLINE_OPTIONS = re.compile(r"\(\s*[a-hA-H]\s*\)")

#: Longest line taken as an answer chip; a longer bullet is a sentence, not a choice.
OPTION_MAX_CHARS = 80


def extract_clarifying_questions(text: str, max_questions: int = 6) -> list[dict]:
    """Question-shaped sentences, in order, deduped case-insensitively.

    A model asked to clarify answers in prose unless told otherwise, so the
    questions have to be dug out of it. The 220-character cap keeps a rambling
    paragraph that happens to end in `?` from becoming a "question" the user is
    expected to answer.
    """
    if not text:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    #: True while the lines just read are a question and its bullets, so a bullet is one of its answers.
    collecting = False

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        # Indented or not: models write the answers flush-left as often as indented. What makes a bullet an
        # answer is that it directly follows a question (or another answer), not how far it is indented.
        is_bullet = bool(re.match(r"^[-*•]\s+", stripped))
        # A bullet under a question is one of its answers, not a question of its own.
        if is_bullet and out and collecting and not stripped.endswith("?"):
            option = re.sub(r"^[-*•]\s+", "", stripped).replace("**", "").strip()
            if option and len(option) <= OPTION_MAX_CHARS:
                out[-1]["options"].append(option)
            continue
        cleaned_line = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", stripped).replace("**", "").strip()
        # "Where are you? (a) just starting, (b) applying" — the lettered choices belong to the question.
        inline: list[str] = []
        marker = INLINE_OPTIONS.search(cleaned_line)
        if marker:
            inline = _inline_options(cleaned_line[marker.start():])
            cleaned_line = cleaned_line[: marker.start()].strip()
        added = 0
        for sentence in re.split(r"(?<=[.!?])\s+", cleaned_line):
            cleaned = sentence.strip().lstrip("*").strip()
            if not cleaned or not cleaned.endswith("?") or len(cleaned) > 220:
                continue
            key = cleaned.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append({"id": f"q{len(out) + 1}", "question": cleaned, "options": []})
            added += 1
        if inline and added:
            out[-1]["options"] = inline
        collecting = bool(added)
    return out[:max_questions]


def _inline_options(text: str) -> list[str]:
    """The choices in "(a) one, (b) two, (c) three)" — the lettered group a model writes inline."""
    options: list[str] = []
    for part in INLINE_OPTIONS.split(text):
        option = part.strip().rstrip(",;.").strip()
        if option.endswith(")") and option.count(")") > option.count("("):
            option = option[:-1].strip()
        option = re.sub(r"^(and|or)\s+", "", option).rstrip(",;.").strip()
        if option and len(option) <= OPTION_MAX_CHARS:
            options.append(option)
    return options


def strip_question_list(text: str) -> str:
    """The prose before the first numbered question: the introduction, without the list the card replaces."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if re.match(r"^\s*\d+[.)]\s", line):
            return "\n".join(lines[:i]).strip()
    return text
