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
from datetime import UTC, date, datetime, time, timedelta
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..calendar_ics import FeedEvent, render_calendar
from ..config import settings
from ..db import get_session
from ..deps import CurrentUser, require_user
from ..ids import new_id
from ..models import (
    CALENDAR_ACTIVE,
    CALENDAR_EMPTIED,
    CALENDAR_REVOKED,
    Blocker,
    CalendarBlock,
    CalendarFeed,
    CalendarSubscription,
    Goal,
    Milestone,
    PlanItem,
    Reminder,
    TimetableBlock,
)
from agentv2.contracts.blocks import BLOCK_ADAPTER
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
#: Apps the "add" links are tailored to; anything else is a plain link.
CALENDAR_PROVIDERS = ("google", "apple", "outlook", "other")
DEFAULT_CALENDAR_NAMES = {"google": "Google Calendar", "apple": "Apple Calendar", "outlook": "Outlook", "other": "My calendar"}
NAME_MAX_CHARS = 60
#: Calendars one person may keep linked at once. Generous; each is only a URL.
MAX_CALENDARS = 10
#: After a delink with "delete events", how long the feed keeps answering (empty) so every calendar app
#: refreshes at least once and drops the events. Apps refresh every few hours to a day.
EMPTIED_FEED_DAYS = 30
#: Length given to a reminder's calendar entry; reminders have a time but no end.
REMINDER_MINUTES = 15
#: Prefixes that say what kind of entry it is in a calendar app, where it sits among the user's other events.
MILESTONE_PREFIX = "Milestone: "
AWAY_PREFIX = "Unavailable: "
DEADLINE_PREFIX = "Goal deadline: "
REMINDER_PREFIX = "Reminder: "


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


def _calendar_row(request: Request, sub: CalendarSubscription) -> dict:
    """One subscribed calendar as the client sees it. Only a live calendar carries its add links."""
    live = sub.status == CALENDAR_ACTIVE
    return {
        "id": sub.id,
        "name": sub.name,
        "provider": sub.provider,
        "status": sub.status,
        "created_at": iso_dt(sub.created_at),
        "last_fetched_at": iso_dt(sub.last_fetched_at),
        "purge_after": iso_dt(sub.purge_after),
        **(_feed_urls(request, sub.token) if live else {}),
    }


async def _envelope(request: Request, session: AsyncSession, user_id: str) -> dict:
    """Every calendar the user has linked (and those still clearing out), plus whether we have asked."""
    feed = await session.get(CalendarFeed, user_id)
    subs = (
        await session.execute(
            select(CalendarSubscription)
            .where(CalendarSubscription.user_id == user_id, CalendarSubscription.status != CALENDAR_REVOKED)
            .order_by(CalendarSubscription.created_at)
        )
    ).scalars().all()
    return {
        "prompted": bool(feed and feed.prompted_at),
        "enabled": any(s.status == CALENDAR_ACTIVE for s in subs),
        "calendars": [_calendar_row(request, s) for s in subs],
    }


async def _get_or_create(session: AsyncSession, user_id: str) -> CalendarFeed:
    feed = await session.get(CalendarFeed, user_id)
    if feed is None:
        feed = CalendarFeed(user_id=user_id)
        session.add(feed)
    return feed


async def _owned(session: AsyncSession, user_id: str, calendar_id: str) -> CalendarSubscription:
    sub = await session.get(CalendarSubscription, calendar_id)
    if sub is None or sub.user_id != user_id or sub.status == CALENDAR_REVOKED:
        raise HTTPException(status_code=404, detail="Calendar not found")
    return sub


@router.get("/calendar/feeds")
async def list_feeds(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    return await _envelope(request, session, user.user_id)


@router.post("/calendar/feeds")
async def link_calendar(
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Link another calendar: a new secret URL, independent of any other. Body: `{name?, provider?}`."""
    if user.is_guest:
        # A guest row is deleted within minutes; a subscription to it would silently go blank.
        raise HTTPException(status_code=403, detail="Sign in to sync your calendar")
    try:
        body = (await request.json()) or {}
    except Exception:
        body = {}
    provider = str(body.get("provider") or "other")
    if provider not in CALENDAR_PROVIDERS:
        provider = "other"
    name = str(body.get("name") or "").strip()[:NAME_MAX_CHARS] or DEFAULT_CALENDAR_NAMES[provider]
    live = (
        await session.execute(
            select(CalendarSubscription).where(
                CalendarSubscription.user_id == user.user_id, CalendarSubscription.status == CALENDAR_ACTIVE
            )
        )
    ).scalars().all()
    if len(live) >= MAX_CALENDARS:
        raise HTTPException(status_code=409, detail=f"You can link up to {MAX_CALENDARS} calendars. Unlink one first.")
    sub = CalendarSubscription(
        id=new_id("cal"), user_id=user.user_id, name=name, provider=provider, token=secrets.token_urlsafe(TOKEN_BYTES)
    )
    session.add(sub)
    feed = await _get_or_create(session, user.user_id)
    feed.prompted_at = feed.prompted_at or datetime.now(UTC)
    await session.commit()
    return {**await _envelope(request, session, user.user_id), "created": sub.id}


@router.patch("/calendar/feeds/{calendar_id}")
async def rename_calendar(
    calendar_id: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    sub = await _owned(session, user.user_id, calendar_id)
    body = (await request.json()) or {}
    name = str(body.get("name") or "").strip()[:NAME_MAX_CHARS]
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    sub.name = name
    await session.commit()
    return await _envelope(request, session, user.user_id)


@router.delete("/calendar/feeds/{calendar_id}")
async def unlink_calendar(
    calendar_id: str,
    request: Request,
    delete_events: bool = False,
    session: AsyncSession = Depends(get_session),
    user: CurrentUser = Depends(require_user),
) -> dict:
    """Delink one calendar; the others are untouched.

    `delete_events=true`: the feed keeps answering for `EMPTIED_FEED_DAYS`, but empty, so the calendar app
    removes every event Sutra created on its next refresh. `false`: the feed stops at once and the calendar
    app keeps what it has, frozen. Either way the subscription itself can only be removed inside that
    calendar app; the client says so.
    """
    sub = await _owned(session, user.user_id, calendar_id)
    now = datetime.now(UTC)
    sub.removed_at = now
    if delete_events:
        sub.status = CALENDAR_EMPTIED
        sub.purge_after = now + timedelta(days=EMPTIED_FEED_DAYS)
    else:
        sub.status = CALENDAR_REVOKED
        sub.purge_after = None
    await session.commit()
    return await _envelope(request, session, user.user_id)


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
    return await _envelope(request, session, user.user_id)


async def _events_for(session: AsyncSession, user_id: str, since: date) -> list[FeedEvent]:
    """Everything the in-app calendar shows, as feed events from calendar_blocks only.
    One source, so the two never disagree."""
    from agentv2.core.recurring import occurrences as _occurrences
    from agentv2.config import RECURRING_HORIZON_DAYS

    goals = {
        g.id: g
        for g in (
            await session.execute(select(Goal).where(Goal.user_id == user_id))
        ).scalars()
    }
    events: list[FeedEvent] = []

    # Phase 5: Read only from calendar_blocks
    cal_blocks = (
        await session.execute(select(CalendarBlock).where(CalendarBlock.user_id == user_id))
    ).scalars()
    today = date.today()
    for row in cal_blocks:
        try:
            blk = BLOCK_ADAPTER.validate_python(row.data)
        except Exception:
            continue
        bk = blk.block_kind
        if bk == "event":
            if blk.repeat and blk.start and blk.end:
                # Expand repeat occurrences
                occs = _occurrences(
                    tuple(blk.repeat.weekdays), blk.start, blk.end,
                    blk.day, blk.repeat.until, today, RECURRING_HORIZON_DAYS
                )
                for occ_day, occ_start, occ_end in occs:
                    if occ_day < since:
                        continue
                    events.append(FeedEvent(
                        uid=f"{row.id}:{occ_day.isoformat()}",
                        title=blk.title,
                        start=occ_day,
                        start_time=occ_start,
                        end_time=occ_end,
                        description=blk.note,
                    ))
            else:
                # Single occurrence
                if blk.day >= since:
                    events.append(FeedEvent(
                        uid=row.id,
                        title=blk.title,
                        start=blk.day,
                        start_time=blk.start,
                        end_time=blk.end,
                        description=blk.note,
                    ))
        elif bk == "task":
            if blk.repeat and blk.start and blk.end:
                occs = _occurrences(
                    tuple(blk.repeat.weekdays), blk.start, blk.end,
                    blk.day, blk.repeat.until, today, RECURRING_HORIZON_DAYS
                )
                for occ_day, occ_start, occ_end in occs:
                    if occ_day < since:
                        continue
                    events.append(FeedEvent(
                        uid=f"{row.id}:{occ_day.isoformat()}",
                        title=blk.title,
                        start=occ_day,
                        start_time=occ_start,
                        end_time=occ_end,
                        description=blk.description,
                        done=blk.state == "done",
                    ))
            else:
                if blk.day and blk.day >= since:
                    events.append(FeedEvent(
                        uid=row.id,
                        title=blk.title,
                        start=blk.day,
                        start_time=blk.start,
                        end_time=blk.end,
                        description=blk.description,
                        done=blk.state == "done",
                    ))
        elif bk == "away":
            if blk.end_date >= since:
                events.append(FeedEvent(
                    uid=row.id,
                    title=f"{AWAY_PREFIX}{blk.title}",
                    start=blk.start_date,
                    end=blk.end_date,
                ))
        elif bk == "milestone":
            if blk.target_date and blk.target_date >= since:
                events.append(FeedEvent(
                    uid=row.id,
                    title=f"{MILESTONE_PREFIX}{blk.title}",
                    start=blk.target_date,
                    description="",
                    done=blk.reached,
                ))

    # Phase 5: Generate goal deadlines on the fly if not in calendar_blocks
    for g in goals.values():
        if g.status in FEED_GOAL_STATUSES and g.target_date and g.target_date >= since:
            events.append(FeedEvent(uid=f"{g.id}-deadline", title=f"{DEADLINE_PREFIX}{g.title}", start=g.target_date))
    return events


@router.get("/calendar/ics/{token}.ics")
async def ics_feed(token: str, session: AsyncSession = Depends(get_session)) -> Response:
    sub = (
        await session.execute(select(CalendarSubscription).where(CalendarSubscription.token == token))
    ).scalar_one_or_none()
    now = datetime.now(UTC)
    if sub is None or not token or sub.status == CALENDAR_REVOKED:
        raise HTTPException(status_code=404, detail="Not found")
    if sub.status == CALENDAR_EMPTIED:
        if sub.purge_after is None or sub.purge_after < now:
            raise HTTPException(status_code=404, detail="Not found")
        # Empty on purpose: a calendar app drops events that disappear from the feed.
        body = render_calendar([], now=now)
    else:
        since = now.date() - timedelta(days=settings.calendar_feed_past_days)
        body = render_calendar(await _events_for(session, sub.user_id, since), now=now)
    sub.last_fetched_at = now
    await session.commit()
    return Response(
        content=body,
        media_type=ICS_MEDIA_TYPE,
        headers={"Cache-Control": "no-store", "Content-Disposition": 'inline; filename="sutra.ics"'},
    )
