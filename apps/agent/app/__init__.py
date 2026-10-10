"""Sutra planning & replanning agent — a library, imported by `apps/api`.

Layout (see `docs/architecture/HLD-planning-agent.md`):

  core/        PURE — no DB, no network, no LLM client
  contracts/   pydantic models — the single source of truth for every shape
  prompts/     one prompt per LLM stage — prose, not shapes
  graph/       the LangGraph StateGraph
  llm/         the one LLM seam
  tui.py       terminal UI for driving the agent end to end

This package exposes no routes. The HTTP surface, the store and the checkpointer
pool live in `apps/api`, which imports the graph in-process.
"""

__version__ = "0.1.0"
