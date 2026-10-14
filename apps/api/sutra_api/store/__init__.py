"""Persistence.

Sits with the service rather than the agent because the engine is opened in this
app's lifespan — but the *vocabulary* is shared: `repo.py` reads the same tables
the planner writes, and `staleness.py` calls the pure classifiers in `core/staleness.py` rather
than re-deriving them. The direction is one-way: `agentv2` never imports from here.
"""
