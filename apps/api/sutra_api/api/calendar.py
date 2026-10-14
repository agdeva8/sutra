"""Calendar subscription feed — the plan, as a `.ics` URL calendar apps poll.

Two halves with different auth:

- `/calendar/feed*` is the signed-in user managing their feed (cookie auth).
- `/calendar/ics/{token}.ics` is fetched by Google/Apple/Outlook servers with no
  cookie, so the unguessable token in the path *is* the credential. Revoking
  nulls it; enabling again mints a new one, which kills every old subscription.

There is no push: "keeps updating" means the calendar app re-fetches, and the
feed is rendered fresh from `plan_items` + `timetable_blocks` on every fetch.
"""
from __future__ import annotations

import secrets
from datetime import UTC, date, datetime, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..calendar_ics import FeedEvent, render_calendar
from ..config import settings
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..models import CalendarFeed, Goal, PlanItem, TimetableBlock
from ..wire import iso_dt

router = APIRouter(tags=["calendar"])

#: Horizons that land on the calendar. Monthly+ items are multi-week bars that
#: bury the day view; the weekly and daily steps are the actionable ones.
FEED_HORIZONS = ("daily", "weekly")
#: Goal statuses whose steps are still worth showing.
FEED_GOAL_STATUSES = ("active",)
TOKEN_BYTES = 32
ICS_MEDIA_TYPE = "text/calendar; charset=utf-8"
GOOGLE_SUBSCRIBE_URL = "https://calendar.google.com/calendar/r?cid={url}"
OUTLOOK_SUBSCRIBE_URL = (
    "https://outlook.live.com/calendar/0/addfromweb?url={url}&name={name}"
)
FEED_NAME = "Sutra plan"


def _feed_urls(request: Request, token: str) -> dict:
    base = settings.calendar_feed_base_url or str(request.base_url).rstrip("/")
    https_url = f"{base}{settings.api_prefix}/calendar/ics/{token}.ics"
    webcal_url = "webcal://" + https_url.split("://", 1)[1]
    return {
        "ics_url": https_url,
        "webcal_url": webcal_url,
        # Google's add-by-URL wants the webcal form; https also works but is
        # treated as a one-off import on some accounts.
        "google_url": GOOGLE_SUBSCRIBE_URL.format(url=quote(webcal_url, safe="")),
        "outlook_url": OUTLOOK_SUBSCRIBE_URL.format(
            url=quote(https_url, safe=""), name=quote(FEED_NAME)
        ),
    }


def _envelope(request: Request, feed: CalendarFeed | None) -> dict:
    enabled = bool(feed and feed.token)
    return {
        "enabled": enabled,
        "prompted": bool(feed and feed.prompted_at),
        "last_fetched_at": iso_dt(feed.last_fetched_at) if feed else None,
        **(_feed_urls(request, feed.token) if enabled else {}),
    }


async def _get_or_create(session: AsyncSession, user_id: str) -> CalendarFeed:
    feed = await session.get(CalendarFeed, user_id)
    if feed is None:
        feed = CalendarFeed(user_id=user_id)
        session.add(feed)
    return feed


@router.get("/calendar/feed")
async def get_feed(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    return _envelope(request, await session.get(CalendarFeed, user.user_id))


@router.post("/calendar/feed")
async def enable_feed(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Turn the feed on. Idempotent: an existing token is kept, not rotated,
    so re-tapping the button never breaks a subscription that already works."""
    if user.is_guest:
        # A guest row is deleted within minutes; a subscription to it would
        # silently go blank. Sign-in first.
        raise HTTPException(status_code=403, detail="Sign in to sync your calendar")
    feed = await _get_or_create(session, user.user_id)
    if not feed.token:
        feed.token = secrets.token_urlsafe(TOKEN_BYTES)
    feed.prompted_at = feed.prompted_at or datetime.now(UTC)
    await session.commit()
    return _envelope(request, feed)


@router.post("/calendar/feed/dismiss")
async def dismiss_prompt(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """"Not now" on the first-open prompt. Recorded server-side so it is asked
    once per account, not once per device."""
    feed = await _get_or_create(session, user.user_id)
    feed.prompted_at = feed.prompted_at or datetime.now(UTC)
    await session.commit()
    return _envelope(request, feed)


@router.delete("/calendar/feed")
async def revoke_feed(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Kill the URL. Calendars that subscribed keep their last copy until they
    next fetch, then get a 404 — Google and Apple stop showing new data."""
    feed = await session.get(CalendarFeed, user.user_id)
    if feed is not None:
        feed.token = None
        feed.last_fetched_at = None
        await session.commit()
    return _envelope(request, feed)


async def _events_for(session: AsyncSession, user_id: str, since: date) -> list[FeedEvent]:
    goals = {
        g.id: g
        for g in (
            await session.execute(select(Goal).where(Goal.user_id == user_id))
        ).scalars()
    }
    items = (
        await session.execute(
            select(PlanItem).where(
                PlanItem.user_id == user_id,
                PlanItem.horizon.in_(FEED_HORIZONS),
            )
        )
    ).scalars()
    events: list[FeedEvent] = []
    for it in items:
        goal = goals.get(it.goal_id) if it.goal_id else None
        if goal is not None and goal.status not in FEED_GOAL_STATUSES:
            continue
        start = it.start_date or it.due_date
        if start is None:
            continue
        end = it.end_date or it.due_date or start
        if end < since:
            continue
        desc = "\n".join(p for p in (goal.title if goal else "", it.phase, it.note) if p)
        events.append(
            FeedEvent(
                uid=it.id, title=it.title, start=start, end=end,
                description=desc, done=it.status == "done",
            )
        )
    blocks = (
        await session.execute(
            select(TimetableBlock).where(
                TimetableBlock.user_id == user_id, TimetableBlock.block_date >= since
            )
        )
    ).scalars()
    for b in blocks:
        events.append(
            FeedEvent(
                uid=b.id, title=b.label, start=b.block_date,
                start_time=b.start_time, end_time=b.end_time,
                description="\n".join(p for p in (b.goal_title, b.note) if p),
            )
        )
    return events


@router.get("/calendar/ics/{token}.ics")
async def ics_feed(token: str, session: AsyncSession = Depends(get_session)) -> Response:
    feed = (
        await session.execute(select(CalendarFeed).where(CalendarFeed.token == token))
    ).scalar_one_or_none()
    if feed is None or not token:
        raise HTTPException(status_code=404, detail="Not found")
    now = datetime.now(UTC)
    since = now.date() - timedelta(days=settings.calendar_feed_past_days)
    body = render_calendar(await _events_for(session, feed.user_id, since), now=now)
    feed.last_fetched_at = now
    await session.commit()
    return Response(
        content=body,
        media_type=ICS_MEDIA_TYPE,
        headers={"Cache-Control": "no-store", "Content-Disposition": 'inline; filename="sutra.ics"'},
    )
