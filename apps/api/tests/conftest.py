"""Pytest fixtures.

**No database fixture, deliberately.** Tests that need Postgres hit the real one
from `infra/docker-compose.yml`, because the schema uses `JSONB` and `ARRAY` —
types SQLite cannot express — so a fake would test a schema the service does not
use. That mirrors `apps/agent`'s convention, where the default `pytest` target is
`tests/unit` and anything touching a shared service is opt-in.

Everything in `tests/unit` therefore imports only pure modules: the `core/`
package, `wire`, `security`, and the `registry`. Those import no driver, no
engine and no HTTP client, which is what lets the unit suite run with nothing
installed but the package itself.
"""
from __future__ import annotations

import os

import pytest

# The origin check refuses a mutating request with no `Origin` header outside
# `test`, and `TestClient` sends none. Set before the settings object is built.
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("AUTH_SECRET", "test-secret-that-is-at-least-32-chars-long")


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    """`get_settings` is `lru_cache`d, so a test that changes env must clear it.

    Autouse because the failure mode otherwise is order-dependent: the first test
    to build settings freezes them for the whole session.
    """
    from sutra_api.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()
