"""Settings, read once from the environment.

Every tunable — the model id, the endpoint, the limits — has a name here and is
read in one place, so changing one is a one-line edit (CLAUDE.md §3).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

#: This package's own `.env`, loaded explicitly rather than relying on the
#: caller's working directory, so `python -m agentv2.demo` works from anywhere.
ENV_PATH = Path(__file__).resolve().parent / ".env"

DEFAULT_BASE_URL = "https://api.deepseek.com"
#: The flash model reads images as well as text, so one model serves triage and
#: photos. (v4-pro does not read images; audio is not accepted by either.)
DEFAULT_MODEL = "deepseek-v4-flash"

#: A ceiling, not a reservation — unused budget is not billed, so this is set
#: high deliberately. DeepSeek's reasoning models bill their reasoning against
#: the same budget, so a low cap gets spent on thinking and returns empty
#: `content`, which reads as a broken model when it is really a broken limit.
#: Both models allow 393,216 output tokens; this is ~8% of that.
DEFAULT_MAX_TOKENS = 32768
DEFAULT_TIMEOUT_S = 120.0


@dataclass(frozen=True)
class Settings:
    """Everything needed to reach a model."""

    api_key: str
    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    max_tokens: int = DEFAULT_MAX_TOKENS
    timeout_s: float = DEFAULT_TIMEOUT_S


def load_settings() -> Settings:
    """Read settings from the environment, failing loudly if the key is absent.

    A missing key is the one failure that cannot be degraded: every call would
    401, and a stack trace is far less useful than a sentence naming the file
    the key belongs in.
    """
    load_dotenv(ENV_PATH, override=False)

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise SystemExit(f"DEEPSEEK_API_KEY is not set — add it to {ENV_PATH}")

    return Settings(
        api_key=api_key,
        base_url=os.environ.get("DEEPSEEK_API_URL", DEFAULT_BASE_URL).strip(),
        model=os.environ.get("DEEPSEEK_MODEL", DEFAULT_MODEL).strip(),
        max_tokens=int(os.environ.get("DEEPSEEK_MAX_TOKENS", DEFAULT_MAX_TOKENS)),
    )


# --- Gateway / validator (step 1) -------------------------------------------

#: Change kinds the gateway may apply without asking (HLD §9). Anything else, and
#: anything that touches a committed block, becomes a proposal.
AUTO_APPLY_KINDS = frozenset({"add_recurring", "stop_recurring", "clear_goal_plan", "complete_item", "add_goal", "add_milestone", "add_task", "add_reminder", "add_block", "link_source", "add_plan_week"})

#: Hours of planned work a single day can hold before the validator rejects more.
DEFAULT_DAILY_CAPACITY_HOURS = 8.0

#: Block statuses. A committed block is something the user fixed (a wedding, a
#: dentist visit); a tentative one is the agent's own placement and is free to move.
BLOCK_COMMITTED = "committed"
BLOCK_TENTATIVE = "tentative"


# --- Triage / slots / reminders (step 2) ------------------------------------
from datetime import time as _time  # noqa: E402

#: Below this, an entry waits for the user instead of being applied (HLD §8).
TRIAGE_CONFIDENCE_MIN = 0.7

#: The hours the agent may schedule into. Outside it is the user's own time.
ACTIVE_WINDOW_START = _time(7, 0)
ACTIVE_WINDOW_END = _time(22, 0)

#: Free gaps shorter than this are not offered to the slot picker.
MIN_WINDOW_MINUTES = 30
#: How far ahead exact slots are offered (HLD §6, slot level).
SLOT_WINDOW_DAYS = 7
#: Length given to a block when the user named a start but no end.
DEFAULT_BLOCK_MINUTES = 60
#: A task's placements may differ from its effort by this much (rounding).
EFFORT_TOLERANCE_HOURS = 0.25

#: Where a reminder's doses fall in the day, by how many a day. Meal-ish times;
#: per-user preferences will override these once they exist.
REMINDER_TIMES = {
    1: [_time(9, 0)],
    2: [_time(9, 0), _time(21, 0)],
    3: [_time(9, 0), _time(14, 0), _time(21, 0)],
    4: [_time(8, 0), _time(13, 0), _time(18, 0), _time(22, 0)],
}
MAX_REMINDER_DAYS = 90
#: Extra model round-trips allowed when the reply is not valid JSON for the schema.
LLM_REPAIR_ROUNDS = 1


# --- Planner (step 3) --------------------------------------------------------

#: How many weeks ahead the week level plans (HLD §6). Months come in step 5.
WEEK_HORIZON = 12
#: Weeks (from this one) that get day-level detail and real blocks; later weeks stay weekly.
DAY_WINDOW_WEEKS = 4
#: One goal may take at most this share of a week's free hours, so goals coexist.
GOAL_MAX_SHARE_OF_FREE = 0.5
#: A week-level plan may land this far under the goal's total before it counts as unusable.
TOTAL_UNDERSHOOT = 0.1
#: Fix attempts after a plan breaks a budget rule, before the code fallback takes over.
FIX_MAX_LOOPS = 2


# --- Goal intake (step 4) ----------------------------------------------------

#: Questions asked before intake must commit to a best-effort draft. A hard stop,
#: so a vague goal can never loop forever (CLAUDE.md principle 6: generous but finite).
MAX_INTAKE_TURNS = 5
#: Upper bound on a goal's length, in weeks. Matches the planner's horizon scale.
INTAKE_MAX_WEEKS = 52


# --- Month level, critic, tick (step 5) --------------------------------------

#: A goal longer than this many weeks gets a month level above the week level (HLD §6).
MONTH_LEVEL_MIN_WEEKS = 8
#: The hours the user focuses best. Sessions are placed here first; the user's own
#: setting will override it once preferences exist.
PEAK_WINDOW_START = _time(8, 0)
PEAK_WINDOW_END = _time(12, 0)
#: The critic flags a session longer than this, or a day crowded with one goal's work.
MAX_SESSION_HOURS = 3.0
MAX_GOAL_HOURS_PER_DAY = 4.0


# --- Entry chat (unsure Scratch entries) --------------------------------------

#: Replies before the chat must settle on what the entry means. Finite so a vague entry cannot loop.
MAX_ENTRY_CHAT_TURNS = 6


# --- Slot choice and timezone -------------------------------------------------

#: Start times the model may choose inside a free window are multiples of this. The model
#: picks among times code offers; it never invents one.
SLOT_GRID_MINUTES = 30
#: Used when a request does not say where the user is. The user's own zone always wins.
DEFAULT_TIMEZONE = "Asia/Kolkata"
#: While False, every user is treated as being in DEFAULT_TIMEZONE (IST) and the zone the browser sends
#: is ignored. The plumbing stays in place; turn this on when users outside India matter.
USE_CLIENT_TIMEZONE = False

#: Two sessions of one goal on the same day must start at least this long after the previous one ends.
MIN_GAP_BETWEEN_SESSIONS_MIN = 30

#: Sessions shorter than this are not worth a calendar slot; the day level rejects them.
MIN_SESSION_HOURS = 0.5


# --- Chat turns (coach chat) --------------------------------------------------

#: The actions a chat turn may propose, in the vocabulary the API's confirm flow already executes.
#: Each maps to the argument names the executor reads (apps/api/sutra_api/store/executor.py).
PROPOSAL_ACTIONS = {
    "update_goal": "goal_title, new_title?, why?, weekly_hours?, target_date?",
    "drop_goal": "goal_title, reason?",
    "pause_goal": "goal_title, reason?",
    "set_goal_dates": "goal_title, start_date?, target_date?",
    "add_milestone": "goal_title, title, target_date?",
    "add_blocker": "title, start_date, end_date?, note?",
}
#: Argument names whose value is a date. The model gives the user's own words ("friday", "in 3 weeks",
#: or an ISO date they stated); code turns them into dates.
PROPOSAL_DATE_ARGS = ("start_date", "end_date", "target_date")
#: How many recent chat turns the model sees.
CHAT_HISTORY_TURNS = 8


# --- Model calls ---------------------------------------------------------------

#: Times the model client retries a failed request (timeout, 5xx, rate limit). Generous.
LLM_MAX_RETRIES = 3


# --- Recurring commitments and progress ---------------------------------------

#: A recurring commitment is laid out as real fixed blocks this many days ahead. The nightly tick keeps
#: extending it, so a rule with no end date never runs out.
RECURRING_HORIZON_DAYS = 120
#: The nightly tick plans a goal again when the hours still to do and the hours still planned differ by
#: more than this (a missed week leaves too little planned; finishing early leaves too much).
REPLAN_DRIFT_HOURS = 2.0


# --- About-you profile (asked once in the first-run flow) ----------------------

#: Label the planner shows the model for the user's own work or study hours, which it never plans into.
PROFILE_WORK_LABEL = "Work or study"
#: A day's last minute. A span that runs past midnight is split here and continues the next day.
END_OF_DAY = _time(23, 59)
#: Weekday keys the profile uses, Monday first (index = Python's weekday()).
PROFILE_WEEKDAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


# --- Progress wording (what a user is told while the planner works) ----------

#: Called from the planner's worker thread; must be thread-safe. `None` means nobody is listening.
PROGRESS_WEEKS = "Working out how the effort spreads across your weeks…"
PROGRESS_WEEK = "Planning the week of {week} — choosing days and times…"
PROGRESS_REVIEW = "Checking the week of {week} against your calendar…"
PROGRESS_APPLY = "Placing everything on your calendar…"
