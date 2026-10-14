"""A per-user cap on the routes that call the model.

Every one of these costs money and seconds, so a loop in a client (or a script) must not be able to run
up a bill. A sliding window per user, in memory: fine for one process; with several workers each keeps
its own window, so the effective cap is the limit times the worker count. A shared store (Redis) is the
fix if that ever matters.
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException

from .deps import CurrentUser, require_user

#: Model-backed requests one user may make per window. Generous: it exists to stop a runaway loop.
LLM_REQUESTS_PER_WINDOW = int(os.environ.get("SUTRA_LLM_REQUESTS_PER_MINUTE", "60"))
WINDOW_SECONDS = 60

_hits: dict[str, deque[float]] = defaultdict(deque)


async def llm_rate_limit(user: CurrentUser = Depends(require_user)) -> None:
    now = time.monotonic()
    hits = _hits[user.user_id]
    while hits and now - hits[0] > WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= LLM_REQUESTS_PER_WINDOW:
        retry = max(1, int(WINDOW_SECONDS - (now - hits[0])))
        raise HTTPException(
            status_code=429, detail="You're going a bit fast. Try again in a moment.", headers={"Retry-After": str(retry)}
        )
    hits.append(now)
