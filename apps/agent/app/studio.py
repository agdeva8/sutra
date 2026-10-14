"""LangSmith Studio entrypoint — the graph, wired for `langgraph dev`.

Studio drives the local Agent Server, so it needs a **module-level compiled
graph**: no arguments, no injection. The two seams the library keeps open have
to be closed here, and only one of them can be.

* `complete` — `build_plan_graph` captures it in the node closures (HLD §15), so
  it must be resolved at import time. `get_complete()` reads `os.environ`, and
  `langgraph.json` points `env` at `.env`, which the CLI loads before importing
  this module. If the key is missing the stub is used — the graph still runs, so
  a silent fallback is indistinguishable from a real model in the trace.
  `graph_provider()` prints which one it picked. (`python -m app.llm.client
  --check` is the fuller self-test.)
* `checkpointer` — **left unset, on purpose.** The Agent Server injects its own
  persistence and hands the graph one that is not ours; passing our own is a
  hard error, not a preference:

      ValueError: Heads up! Your graph 'graph' from './app/studio.py' includes a
      custom checkpointer (type InMemorySaver). With LangGraph API, persistence
      is handled automatically by the platform.

  So `checkpointer=None` here is load-bearing, and the clarify interrupt still
  works: the platform's checkpointer is what makes the thread resumable from the
  Studio UI. Durable checkpointing for the product stays in `apps/api` against
  Postgres.

This module is the *only* thing `langgraph dev` imports, so nothing in `app/`
changes for it, and no production path goes through here.

Input: the graph's input IS `PlanState`, so Studio's input box wants the state
dict, not `{"message": ...}`. Missing keys are not defaulted for you — the nodes
read them with `.get(...)` and `n_headroom` does arithmetic on `capacity_hours`.
`apps/agent/studio_input.json` is a complete, paste-ready starting state; Studio
remembers it between runs.
"""
from __future__ import annotations

from app.graph.build import build_plan_graph
from app.llm.client import get_complete, resolve_provider

#: Resolved once, at import. `None` means the offline stub — see the module
#: docstring for why that is the dangerous case rather than the safe one.
_PROVIDER = resolve_provider()

#: No checkpointer: the Agent Server supplies one (see the module docstring).
#: This is the only call site that passes `None` — `run_plan`/`run_replan` and
#: the TUI still get the in-memory saver, because they run outside a server.
graph = build_plan_graph(complete=get_complete(), checkpointer=None)


def graph_provider() -> str:
    """Which model backend this module bound to. Printed, not inferred."""
    return f"{_PROVIDER.name}/{_PROVIDER.model}" if _PROVIDER else "stub (no API key in env)"


if __name__ == "__main__":
    print(f"studio graph: plan — provider {graph_provider()}")
