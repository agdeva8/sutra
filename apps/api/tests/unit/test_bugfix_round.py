"""Regressions for the end-to-end test round: storage, auth cache, headers, batch confirm, dates, copy."""
import asyncio
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

from fastapi.testclient import TestClient

from agentv2.coach.prompts import KIND_PLAN_DAY, PLAN_DAY_MODE, mode_hint
from sutra_api import deps, storage
from sutra_api.api import chat as chat_routes
from sutra_api.api.tools import BATCH_FIRST_ACTION, _with_milestone_dates
from sutra_api.config import settings
from sutra_api.coach_context import CoachFacts, render
from sutra_api.main import PER_USER_CACHE_CONTROL, app
from sutra_api.store.executor import DUPLICATE_TITLE_RATIO, _as_date, _norm_title

from difflib import SequenceMatcher


# --- storage: no ephemeral disk on a serverless host --------------------------------------------------------


def test_serverless_host_never_uses_local_disk(monkeypatch):
    monkeypatch.setattr(settings, "vercel", "1")
    assert storage._use_local_disk() is False
    monkeypatch.setattr(settings, "vercel", "")
    assert storage._use_local_disk() is True


def test_serverless_put_goes_to_the_database_blob_table(monkeypatch):
    monkeypatch.setattr(settings, "vercel", "1")
    monkeypatch.setattr(settings, "supabase_url", "")
    seen = {}

    async def fake_db_put(key, data, content_type):
        seen["key"], seen["data"] = key, data

    monkeypatch.setattr(storage, "_db_put", fake_db_put)
    asyncio.run(storage.put(key="sources/u/a.png", data=b"x", content_type="image/png"))
    assert seen == {"key": "sources/u/a.png", "data": b"x"}


# --- dates ---------------------------------------------------------------------------------------------------


def test_spoken_dates_are_understood():
    assert _as_date("14 March 2027") == date(2027, 3, 14)
    assert _as_date("14th March 2027") == date(2027, 3, 14)
    assert _as_date("March 14, 2027") == date(2027, 3, 14)
    assert _as_date("2027-03-14") == date(2027, 3, 14)
    assert _as_date("sometime soon") is None


def _row(id, action, **args):
    return SimpleNamespace(id=id, action=action, args=args)


def test_undated_milestones_are_spread_to_the_deadline():
    target = datetime.now(UTC).date() + timedelta(days=100)
    rows = [
        _row("g", BATCH_FIRST_ACTION, title="Switch jobs", target_date=target.isoformat()),
        _row("m1", "add_milestone", title="A"),
        _row("m2", "add_milestone", title="B", target_date="2027-01-01"),
        _row("m3", "add_milestone", title="C"),
    ]
    args = _with_milestone_dates(rows)
    assert args["m2"]["target_date"] == "2027-01-01"  # an existing date is kept
    assert date.fromisoformat(args["m1"]["target_date"]) < date.fromisoformat(args["m3"]["target_date"]) == target


def test_spoken_goal_deadline_is_normalised_for_the_batch():
    rows = [_row("g", BATCH_FIRST_ACTION, title="T", target_date="14 March 2099")]
    assert _with_milestone_dates(rows)["g"]["target_date"] == "2099-03-14"


# --- duplicates ----------------------------------------------------------------------------------------------


def test_near_duplicate_titles_match_and_different_goals_do_not():
    def alike(a, b):
        return SequenceMatcher(None, _norm_title(a), _norm_title(b)).ratio() >= DUPLICATE_TITLE_RATIO

    assert alike("Switch jobs in 3 months", "Switch jobs in 3 months!")
    assert alike("Get fit", "get fit.")
    assert not alike("Switch jobs in 3 months", "Run a half marathon")


# --- auth cache ----------------------------------------------------------------------------------------------


def test_identity_cache_expires_and_can_be_forgotten(monkeypatch):
    user = deps.CurrentUser(user_id="u1", is_guest=False, source="session")
    deps._identity_cache.clear()
    deps._cache_put("s:tok", user)
    assert deps._cache_get("s:tok") is user
    deps.forget_identity(user_id="u1")
    assert deps._cache_get("s:tok") is None

    deps._cache_put("s:tok", user)
    deps.forget_identity(session_token="tok")
    assert deps._cache_get("s:tok") is None

    deps._cache_put("s:tok", user)
    monkeypatch.setattr(deps.time, "monotonic", lambda: 10**9)
    assert deps._cache_get("s:tok") is None


# --- headers -------------------------------------------------------------------------------------------------


def test_api_responses_carry_security_headers_and_are_never_publicly_cacheable():
    res = TestClient(app).get("/health")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert res.headers["x-frame-options"] == "DENY"
    assert "referrer-policy" in res.headers
    assert "frame-ancestors" in res.headers["content-security-policy"]
    assert res.headers["cache-control"] == PER_USER_CACHE_CONTROL
    assert "public" not in res.headers["cache-control"]


# --- coach copy and context ----------------------------------------------------------------------------------


def test_plan_my_day_has_its_own_status_copy_and_mode():
    lines = chat_routes._status_lines(KIND_PLAN_DAY, n_sources=0, has_history=False, interview=True)
    assert chat_routes.STATUS_PROPOSE not in lines
    assert chat_routes.STATUS_DAY_TIMETABLE in lines
    hint = mode_hint(proactive_propose=False, clarify=False, auto_answer=False, scoped_kind=KIND_PLAN_DAY)
    assert hint == PLAN_DAY_MODE and "TODAY'S TIMETABLE" in hint


def test_todays_timetable_reaches_the_coach_including_planned_prep():
    from datetime import time

    text = render(CoachFacts(today=date(2026, 10, 15), today_blocks=[(time(18, 0), time(19, 30), "LLD prep")]))
    assert "TODAY'S TIMETABLE" in text and "18:00-19:30 LLD prep" in text


# --- second round: dismiss, display preferences, replan follow-up, honest model labels -------------------------

import pytest

from sutra_api.api.preferences import clean_display
from sutra_api.db import get_session
from sutra_api.deps import require_user
from sutra_api.registry import MODEL_OPTIONS


class _FakeSession:
    def __init__(self, entry):
        self.entry, self.committed = entry, False

    async def get(self, _model, _id):
        return self.entry

    async def commit(self):
        self.committed = True


def _client(entry):
    session = _FakeSession(entry)

    async def fake_session():
        yield session

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_user] = lambda: deps.CurrentUser(user_id="u1", is_guest=False, source="session")
    return TestClient(app), session


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def _entry(**kw):
    base = dict(id="e1", user_id="u1", status="handled", result={"proposed": True})
    return SimpleNamespace(**{**base, **kw})


def test_dismiss_marks_a_proposal_entry_dismissed():
    client, session = _client(_entry())
    res = client.post("/api/scratch/e1/dismiss")
    assert res.status_code == 200 and res.json() == {"ok": True}
    assert session.entry.status == "dismissed" and session.committed


def test_dismiss_refuses_entries_with_nothing_to_dismiss_or_not_yours():
    client, _ = _client(_entry(result={"proposed": False}))
    assert client.post("/api/scratch/e1/dismiss").status_code == 409
    client, _ = _client(_entry(user_id="someone-else"))
    assert client.post("/api/scratch/e1/dismiss").status_code == 404
    client, _ = _client(None)
    assert client.post("/api/scratch/e1/dismiss").status_code == 404


def test_display_preferences_accept_valid_keys_only():
    assert clean_display({"theme": "dark", "font_size": 16, "junk": 1}) == {"theme": "dark", "font_size": 16}
    for bad in ({"theme": "purple"}, {"font_size": 99}, {"font_size": "16"}, {"font_size": True}, []):
        with pytest.raises(ValueError):
            clean_display(bad)


def test_replan_follow_up_route_exists_and_writes_no_longer_replan_inline():
    assert "post" in app.openapi()["paths"]["/api/timetable/replan-conflicts"]
    import inspect

    from sutra_api.api import blockers, timetable

    for module in (timetable, blockers):
        assert "run_after(background, replan_conflicts_for" not in inspect.getsource(module)


def test_replan_follow_up_runs_the_replan(monkeypatch):
    from sutra_api.api import timetable

    calls = []

    async def fake(user_id, tz):
        calls.append((user_id, tz))

    monkeypatch.setattr(timetable, "replan_conflicts_for", fake)
    client, _ = _client(None)
    res = client.post("/api/timetable/replan-conflicts", headers={"X-Timezone": "Asia/Kolkata"})
    assert res.status_code == 200 and calls == [("u1", "Asia/Kolkata")]


def test_model_list_no_longer_names_a_model_it_does_not_use():
    assert all("Sonnet" not in o["hint"] and "GPT" not in o["hint"] for o in MODEL_OPTIONS)
