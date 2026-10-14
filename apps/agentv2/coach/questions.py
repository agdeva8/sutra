"""Question discipline, in code: never ask the same thing twice, never too many at once.

The prompt asks for this too, but a prompt is a request. A model that re-asks an unanswered question
reworded ("How many hours a week can you give?" -> "How much time per week can you commit?") slips
past an exact-match check and past its own instructions, so the comparison here is fuzzy: word-set
overlap after normalising, plus character similarity for close rewordings.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

#: Two questions at or above either score are the same question. Overlap is the Dice coefficient of
#: their content words (2|A&B| / (|A|+|B|)), so a short question sharing two words with a long one is
#: not a repeat, while a reworded copy is.
REPEAT_TOKEN_OVERLAP = 0.6
REPEAT_CHAR_SIMILARITY = 0.8
#: Words that carry no meaning for "is this the same question".
STOPWORDS = frozenset(
    "a an the and or of to for in on at by with from is are am be do does did you your yours i me my we "
    "our this that these those it its what which who how when where why would could can will should "
    "there any some have has had so if just really currently right now please about per into than".split()
)
#: Trailing letters stripped so "hours"/"hour", "committing"/"commit" compare equal.
_SUFFIX = re.compile(r"(ing|ed|es|s)$")
#: The prompt asks the model to name the goal in each question ("For your guitar goal, ..."). That
#: shared lead-in would make every question in a round look alike, so it is not compared.
_GOAL_LEAD_IN = re.compile(r"^\s*(for|about|on|with|regarding)\b[^,?]{0,80},\s*", re.I)
#: Words that mean the same thing in a planning question, mapped to one. Small on purpose: it covers
#: the rewordings models actually make when they re-ask ("hours a week you can give" -> "time per
#: week you can commit"), not a thesaurus.
SYNONYMS = {
    "time": "hour", "commit": "give", "spare": "give", "dedicate": "give", "put": "give", "devote": "give",
    "current": "start", "level": "start", "today": "start", "begin": "start", "experience": "start",
    "deadline": "date", "due": "date", "weekly": "week", "much": "many", "fix": "fixed", "firm": "fixed",
    "hard": "fixed",
}


def _tokens(text: str) -> set[str]:
    text = _GOAL_LEAD_IN.sub("", text or "")
    words = re.findall(r"[a-z0-9]+", text.lower())
    out = set()
    for w in words:
        if w in STOPWORDS:
            continue
        w = _SUFFIX.sub("", w) if len(w) > 4 else w
        out.add(SYNONYMS.get(w, w))
    return out


def _normal(text: str) -> str:
    return " ".join(sorted(_tokens(text)))


def is_repeat(question: str, asked: list[str]) -> bool:
    """True when `question` is one of `asked`, allowing for rewording."""
    mine = _tokens(question)
    norm = _normal(question)
    for prior in asked:
        theirs = _tokens(prior)
        if mine and theirs:
            overlap = 2 * len(mine & theirs) / (len(mine) + len(theirs))
            if overlap >= REPEAT_TOKEN_OVERLAP:
                return True
        if norm and SequenceMatcher(None, norm, _normal(prior)).ratio() >= REPEAT_CHAR_SIMILARITY:
            return True
    return False


def filter_repeats(questions: list[dict], asked: list[str]) -> list[dict]:
    """The questions not already asked, and not repeating each other within this round."""
    kept: list[dict] = []
    seen = list(asked)
    for q in questions:
        text = str(q.get("question") or "")
        if is_repeat(text, seen):
            continue
        kept.append(q)
        seen.append(text)
    return kept


#: Topics the profile can already answer, with what marks a question as being about one. A question on
#: a topic the user already answered in their profile is dropped: they told us once.
PROFILE_TOPICS: dict[str, re.Pattern[str]] = {
    "weekly_goal_hours": re.compile(
        r"\b(hours?|time)\b.*\b(week|weekly|per week|a week|commit|give|spare|dedicate)\b"
        r"|\bhow much time\b", re.I),
    "work_hours": re.compile(r"\b(work|study|office|shift)\s+(hours|schedule|timings?)\b|\bwhen do you work\b", re.I),
    "sleep": re.compile(r"\b(wake|sleep|bedtime)\b", re.I),
}


def drop_answered_by_profile(questions: list[dict], answered: set[str]) -> list[dict]:
    """Questions about a topic the profile already answers are removed."""
    patterns = [PROFILE_TOPICS[t] for t in answered if t in PROFILE_TOPICS]
    return [q for q in questions if not any(p.search(str(q.get("question") or "")) for p in patterns)]
