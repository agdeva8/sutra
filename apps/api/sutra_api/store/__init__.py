"""Persistence.

Sits with the service rather than the agent because the engine is opened in this
app's lifespan — but the *vocabulary* is shared: `repo.py` reads the same tables
the planner writes, and `staleness.py` calls the agent's pure classifiers rather
than re-deriving them. That direction is one-way; `apps/agent` never imports
from here.
"""
