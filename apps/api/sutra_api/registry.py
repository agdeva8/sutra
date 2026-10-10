"""The model catalog — the provider switcher's data.

Ported from v1's `lib/emergent/model-registry.ts`. Client-safe pure data: no env
access, no I/O, which is why `/preferences/models` needs no auth — it is a
constant.

**All three rows currently resolve to the same wire model.** v1 did this for the
MVP: the labels are cosmetic, and the switcher's choice does not yet change which
model answers. The strings to restore per row are recorded below so switching
back is a one-line change rather than an archaeology exercise.

`anthropic` is accepted as an input alias for `claude` and **echoed back
unchanged** — v1's `PUT /preferences` returns what was sent, not what it stored,
so a client that round-trips its own value sees no drift.
"""
from __future__ import annotations

from typing import TypedDict

#: The id the app uses; `provider` is what a wire call would route on.
ProviderId = str

#: The one model every provider currently maps to.
_WIRE_MODEL = "deepseek-flash"

#: The pre-DeepSeek strings, kept so restoring them is a copy-paste:
#:   gemini → "gemini-3-flash-preview" · claude → "claude-sonnet-4-5" · openai → "gpt-5.4"


class ModelEntry(TypedDict):
    id: str
    label: str
    hint: str
    provider: str
    model: str


MODEL_REGISTRY: dict[str, ModelEntry] = {
    "gemini": {
        "id": "gemini",
        "label": "Gemini",
        "hint": "3 Flash",
        "provider": "gemini",
        "model": _WIRE_MODEL,
    },
    "claude": {
        "id": "claude",
        "label": "Claude",
        "hint": "Sonnet 4.5",
        "provider": "anthropic",
        "model": _WIRE_MODEL,
    },
    "openai": {
        "id": "openai",
        "label": "OpenAI",
        "hint": "GPT-5.4",
        "provider": "openai",
        "model": _WIRE_MODEL,
    },
}

#: The switcher's list. `value` is the `ProviderId`, the rest is display.
MODEL_OPTIONS: list[dict] = [
    {"value": entry["id"], "label": entry["label"], "hint": entry["hint"]}
    for entry in MODEL_REGISTRY.values()
]

#: Input aliases → a registry key. `anthropic` is the provider name leaking into
#: a field that holds an app id; accepted for compatibility, never stored.
_ALIASES = {"anthropic": "claude"}

#: The provider the schema defaults to when a user has never chosen.
DEFAULT_PROVIDER = "gemini"


def resolve_provider_id(raw: object) -> str | None:
    """A registry key, or `None` if the value names nothing.

    Returns `None` rather than falling back to the default: a route must be able
    to answer 400 `Invalid provider` for a typo, and a silent default would make
    `{"model_provider": "gpt-5"}` succeed while doing nothing.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if value in MODEL_REGISTRY:
        return value
    return _ALIASES.get(value)


def echo_provider(raw: str, resolved: str) -> str:
    """What `PUT /preferences` returns: the alias if one was sent, else the id."""
    return "anthropic" if raw.strip() == "anthropic" else resolved
