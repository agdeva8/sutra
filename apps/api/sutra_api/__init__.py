"""Sutra API — the one HTTP surface `apps/web` talks to.

The service imports `agentv2` (the planner and the coach) in-process; `agentv2` imports nothing from here,
so the dependency runs one way.
"""
