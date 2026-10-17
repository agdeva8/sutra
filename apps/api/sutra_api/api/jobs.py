"""`POST /jobs/run` — drain the signed-in user's due jobs, streaming their progress.

The client calls this after enqueuing work (a build, a re-plan, a calendar edit) and
keeps the stream open until the job finishes. That is what makes the queue usable on
a serverless host: the work runs inside a request the client is holding, rather than
after a response the host has already frozen.

It is deliberately not a "run any job" endpoint: only the caller's own jobs are
claimable here (`run_user_jobs` is scoped by user). Other users' jobs are drained by
`/cron/jobs`, which the scheduler calls.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..deps import CurrentUser, require_user
from ..jobs import run_user_jobs
from ..stream import progress_stream, sse_response, wants_stream

router = APIRouter(tags=["jobs"])

#: The first frame's line, before the first job says anything.
RUN_FIRST = "Checking for work…"


@router.post("/jobs/run")
async def run_jobs(
    request: Request,
    user: CurrentUser = Depends(require_user),
) -> object:
    """Run every due job this user has, one at a time.

    Streamed when the client asks for SSE (the ordinary path) and a plain JSON body
    otherwise, so a script can drain without parsing frames.
    """

    async def work(say) -> dict:
        return await run_user_jobs(user.user_id, say)

    if wants_stream(request):
        return sse_response(progress_stream(work, first=RUN_FIRST))
    return await work(lambda _line: None)
