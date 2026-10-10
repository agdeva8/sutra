"""Tracing is opt-in: with no key, every helper must be inert.

That is the load-bearing property — the offline TUI and the whole test suite
run with no LangSmith account, and a stray env var must not change that.
"""
from __future__ import annotations

import pytest

from app.observability import (
    DEFAULT_PROJECT,
    configure_tracing,
    run_url,
    tracing_enabled,
    turn_trace,
)

KEYS = (
    "LANGSMITH_API_KEY",
    "LANGSMITH_TRACING",
    "LANGSMITH_PROJECT",
    "LANGSMITH_ENDPOINT",
    "LANGCHAIN_API_KEY",
    "LANGCHAIN_TRACING_V2",
    "LANGCHAIN_PROJECT",
    "LANGCHAIN_ENDPOINT",
)


@pytest.fixture
def clean_env(monkeypatch):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    return monkeypatch


def test_off_without_a_key(clean_env):
    assert tracing_enabled() is False
    assert configure_tracing() is None
    with turn_trace("turn") as run:
        assert run is None


def test_a_key_alone_turns_it_on(clean_env):
    clean_env.setenv("LANGSMITH_API_KEY", "lsv2_pt_x")
    assert tracing_enabled() is True
    assert configure_tracing() == DEFAULT_PROJECT


def test_explicit_opt_out_wins_over_the_key(clean_env):
    clean_env.setenv("LANGSMITH_API_KEY", "lsv2_pt_x")
    clean_env.setenv("LANGSMITH_TRACING", "false")
    assert tracing_enabled() is False
    assert configure_tracing() is None


def test_configure_sets_both_env_spellings(clean_env):
    """LangGraph's tracer and the LangSmith client read different names."""
    import os

    clean_env.setenv("LANGSMITH_API_KEY", "lsv2_pt_x")
    clean_env.setenv("LANGSMITH_PROJECT", "my-project")

    assert configure_tracing() == "my-project"
    assert os.environ["LANGCHAIN_TRACING_V2"] == "true"
    assert os.environ["LANGCHAIN_PROJECT"] == "my-project"
    assert os.environ["LANGCHAIN_API_KEY"] == "lsv2_pt_x"


def test_run_url_is_none_safe():
    assert run_url(None) is None


async def test_turn_carries_no_url_when_off(clean_env):
    """A turn's result must not grow a trace_url key value out of nowhere."""
    from app.graph.build import run_plan

    res = await run_plan(message="I want to learn Rust, 6 hours a week")
    assert res.get("trace_url") is None
    assert res.get("kind") in {"ok", "no_change", "clarify", "renegotiate"}
