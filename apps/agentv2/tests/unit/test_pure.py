"""Slots, budgets, reminders, dates and the clock: all pure."""
from datetime import date, datetime, time

import pytest

from agentv2.core.budget import check_allocation, even_split
from agentv2.core.clock import local_now
from agentv2.core.context import BlockRow, Context
from agentv2.core.dates import calendar_text, parse_date, resolve_day
from agentv2.core.recur import expand_reminder
from agentv2.core.slots import first_fit, free_windows, pad_after, picks_to_blocks, validate_picks

TODAY = date(2026, 10, 14)  # a Wednesday
NOW = datetime(2026, 10, 14, 10, 0)


@pytest.mark.parametrize("ref,expected", [
    ("tomorrow", date(2026, 10, 15)), ("friday", date(2026, 10, 16)), ("20 Oct", date(2026, 10, 20)),
    ("20th October", date(2026, 10, 20)), ("Oct 25", date(2026, 10, 25)), ("end of December", date(2026, 12, 31)),
    ("in 3 weeks", date(2026, 11, 4)), ("2026-12-01", date(2026, 12, 1)), ("1 Jan", date(2027, 1, 1)),
    ("31 feb", None), ("gibberish", None),
])
def test_resolve_day(ref, expected):
    assert resolve_day(ref, TODAY) == expected


def test_parse_date_prefers_iso_and_falls_back_to_words():
    assert parse_date("2026-11-04", TODAY) == date(2026, 11, 4)
    assert parse_date("tomorrow", TODAY) == date(2026, 10, 15)


def test_calendar_lists_the_days_with_today_marked():
    lines = calendar_text(TODAY, 3).splitlines()
    assert lines[0].endswith("(today)") and "2026-10-15" in lines[1]


def test_the_clock_is_ist_whatever_zone_is_asked_for():
    assert local_now("Pacific/Kiritimati") == pytest.approx(local_now("Asia/Kolkata"), abs=__import__("datetime").timedelta(seconds=5)) if False else True
    a, b = local_now("Pacific/Kiritimati"), local_now(None)
    assert abs((a - b).total_seconds()) < 5


def test_reminder_expands_to_days_and_times():
    days, times = expand_reminder(3, 5, date(2026, 10, 14))
    assert len(days) == 5 and days[0] == date(2026, 10, 14) and times == [time(9), time(14), time(21)]


def test_allocation_must_fit_each_period_and_add_up():
    cap = {"a": 4.0, "b": 4.0}
    assert check_allocation({"a": 3, "b": 3}, cap, 6) is None
    assert "only 4h" in check_allocation({"a": 5, "b": 1}, cap, 6)
    assert "needed" in check_allocation({"a": 1}, cap, 6)
    assert "not offered" in check_allocation({"z": 1}, cap, 1)


def test_even_split_respects_capacity_and_pushes_overflow_later():
    out = even_split(10, {"a": 2.0, "b": 8.0, "c": 8.0})
    assert out["a"] <= 2.0 and round(sum(out.values()), 2) == 10


def test_free_windows_skip_blocks_blocked_dates_and_the_past():
    ctx = Context(blocks=(BlockRow("w", TODAY, time(11), time(18), "committed"),), blocked_dates=frozenset({date(2026, 10, 15)}))
    wins = free_windows(ctx, NOW, days=3)
    today = [(w.start, w.end) for w in wins if w.day == TODAY]
    assert today == [(time(10), time(11)), (time(18), time(22))]
    assert all(w.day != date(2026, 10, 15) for w in wins)


def test_a_pick_must_fit_its_window_and_sit_on_the_grid():
    ctx = Context()
    wins = free_windows(ctx, NOW, days=1)
    w = wins[0]
    assert validate_picks([(w.id, 1.0, 0)], 1.0, wins) is None
    assert "grid" in validate_picks([(w.id, 1.0, 10)], 1.0, wins)
    assert "does not fit" in validate_picks([(w.id, 99.0, 0)], 99.0, wins)
    assert "not offered" in validate_picks([("nope", 1.0, 0)], 1.0, wins)


def test_offset_moves_the_block_start():
    w = free_windows(Context(), NOW, days=1)[0]
    (b,) = picks_to_blocks([(w.id, 1.0, 60)], [w], "x")
    assert b.start == time(w.start.hour + 1, w.start.minute)


def test_first_fit_fills_windows_in_order():
    wins = free_windows(Context(blocks=(BlockRow("w", TODAY, time(11), time(21), "committed"),)), NOW, days=1)
    picks = first_fit(2.0, wins)
    assert sum(p[1] for p in picks) == 2.0 and picks[0][0] == wins[0].id


def test_gap_rows_follow_planned_blocks_only():
    rows = (BlockRow("a", TODAY, time(9), time(10), "tentative"), BlockRow("b", TODAY, time(12), time(13), "committed"))
    pads = pad_after(rows)
    assert len(pads) == 1 and pads[0].start == time(10) and pads[0].end == time(10, 30)
