"""The per-user cap on model-backed routes."""
import asyncio

import pytest
from fastapi import HTTPException

from sutra_api import rate_limit
from sutra_api.deps import CurrentUser


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    rate_limit._hits.clear()
    monkeypatch.setattr(rate_limit, "LLM_REQUESTS_PER_WINDOW", 3)


def call(user):
    return asyncio.run(rate_limit.llm_rate_limit(user))


def test_requests_under_the_cap_pass_and_the_next_is_refused():
    u = CurrentUser(user_id="u1", is_guest=False, source="session")
    for _ in range(3):
        call(u)
    with pytest.raises(HTTPException) as e:
        call(u)
    assert e.value.status_code == 429 and "Retry-After" in e.value.headers


def test_one_users_requests_do_not_count_against_another():
    a, b = CurrentUser(user_id="a", is_guest=False, source="session"), CurrentUser(user_id="b", is_guest=False, source="session")
    for _ in range(3):
        call(a)
    call(b)  # still allowed
