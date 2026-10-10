"""LangSmith tracing — opt-in, env-driven, and inert when unconfigured.

Nothing here is required to run the agent. When no key is configured every
helper is a no-op, so the offline TUI and the tests behave exactly as before.

Turn it on by exporting a key:

    export LANGSMITH_API_KEY=lsv2_pt_…
    export LANGSMITH_PROJECT=sutra-agent        # optional, this is the default
    # export LANGSMITH_TRACING=false            # explicit opt-out

A key alone is enough — `configure_tracing()` sets the env spellings both
LangGraph and LangSmith read, so there is no config file to keep in sync.

What shows up in the trace:

* `plan.turn` — the parent chain run for one turn, with the message and the
  thread id as metadata. Its URL is returned in the run result as `trace_url`.
* every graph node (`n_intake`, `n_plan`, `n_place`, …) as a nested chain run,
  with the state updates it produced.
* `llm.complete` — one LLM run per model call, carrying the schema name, the
  provider and the model id.

The LLM runs come from `app/llm/client.py`, not from LangChain: the provider
speaks the OpenAI wire format over httpx, so without `@traceable` those calls
would be invisible in the trace.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator

#: Project used when the caller names none.
DEFAULT_PROJECT = "sutra-agent"

#: Truthy spellings. LangSmith's own client accepts these; being strict here
#: would silently ignore `LANGSMITH_TRACING=1`, which people do type.
_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSEY = frozenset({"0", "false", "no", "off"})


def _env(*names: str) -> str:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    return ""


def api_key() -> str:
    return _env("LANGSMITH_API_KEY", "LANGCHAIN_API_KEY")


def tracing_enabled() -> bool:
    """True when traces will actually be sent.

    A key turns tracing on by default; `LANGSMITH_TRACING` (or the older
    `LANGCHAIN_TRACING_V2`) overrides that either way.
    """
    if not api_key():
        return False
    flag = _env("LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2").lower()
    if flag in _FALSEY:
        return False
    if flag in _TRUTHY:
        return True
    return True  # key present, nothing said — trace


def configure_tracing() -> str | None:
    """Normalise the env and return the project name, or None when off.

    Idempotent, and cheap enough to call on every entry point. Sets both the
    `LANGSMITH_*` and `LANGCHAIN_*` spellings because the LangGraph tracer and
    the LangSmith client read different ones.
    """
    if not tracing_enabled():
        return None

    key = api_key()
    project = _env("LANGSMITH_PROJECT", "LANGCHAIN_PROJECT") or DEFAULT_PROJECT
    endpoint = _env("LANGSMITH_ENDPOINT", "LANGCHAIN_ENDPOINT")

    os.environ["LANGSMITH_API_KEY"] = key
    os.environ["LANGSMITH_TRACING"] = "true"
    os.environ["LANGSMITH_PROJECT"] = project
    os.environ["LANGCHAIN_API_KEY"] = key
    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_PROJECT"] = project
    if endpoint:
        os.environ["LANGSMITH_ENDPOINT"] = endpoint
        os.environ["LANGCHAIN_ENDPOINT"] = endpoint

    # The shed-during-shutdown hint: without this, langsmith's background
    # uploader can be cut off when the TUI exits and the trace never lands.
    os.environ.setdefault("LANGCHAIN_CALLBACKS_BACKGROUND", "true")
    return project


@contextmanager
def turn_trace(
    name: str, inputs: dict | None = None, metadata: dict | None = None
) -> Iterator[Any]:
    """The parent run for one turn, or a null context when tracing is off.

    Yields the `RunTree` (or None). The graph's own runs nest under it, which
    is what makes a single turn readable as one trace rather than a dozen
    orphans.
    """
    if not configure_tracing():
        yield None
        return

    from langsmith.run_helpers import trace

    with trace(
        name=name,
        run_type="chain",
        inputs=inputs or {},
        metadata=metadata or {},
    ) as run_tree:
        yield run_tree


def run_url(run_tree: Any) -> str | None:
    """Best-effort deep link for a finished run. Never raises."""
    if run_tree is None:
        return None
    try:
        return run_tree.get_url()
    except Exception:
        return None
