"""Streamed long jobs, and the calendar feed's per-calendar states."""
import asyncio
import json
from datetime import UTC, datetime

from fastapi import HTTPException

from sutra_api.calendar_ics import FeedEvent, render_calendar
from sutra_api.stream import progress_stream


def _frames(work):
    async def collect():
        return [chunk async for chunk in progress_stream(work, first="Got it.")]

    out = []
    for chunk in asyncio.run(collect()):
        if chunk.startswith("data: "):
            out.append(json.loads(chunk[6:]))
    return out


def test_progress_lines_arrive_before_the_result():
    async def work(say):
        say("Reading…")
        await asyncio.sleep(0)
        say("Filing…")
        return {"ok": True}

    frames = _frames(work)
    assert [f["content"] for f in frames if f["type"] == "status"] == ["Got it.", "Reading…", "Filing…"]
    assert frames[-1] == {"type": "result", "result": {"ok": True}}


def test_a_failing_job_ends_in_an_error_frame_not_a_broken_stream():
    async def work(say):
        raise HTTPException(status_code=422, detail="Couldn't plan this safely.")

    last = _frames(work)[-1]
    assert last["type"] == "error" and last["status"] == 422 and "plan" in last["content"]


def test_say_may_be_called_from_a_worker_thread():
    async def work(say):
        await asyncio.to_thread(say, "From a thread")
        return {}

    assert "From a thread" in [f.get("content") for f in _frames(work)]


def test_an_emptied_feed_is_a_valid_calendar_with_no_events():
    now = datetime(2026, 10, 15, tzinfo=UTC)
    empty = render_calendar([], now=now)
    assert "BEGIN:VCALENDAR" in empty and "BEGIN:VEVENT" not in empty
    full = render_calendar([FeedEvent(uid="a", title="Milestone: x", start=now.date())], now=now)
    assert full.count("BEGIN:VEVENT") == 1
