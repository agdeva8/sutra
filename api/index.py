"""Vercel entry point: the FastAPI app, with the two sibling packages put on the path.

The repo is not pip-installable as one unit (agentv2 and sutra_api are sibling folders), so the
function adds them to `sys.path` instead of installing them.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "apps"), str(ROOT / "apps" / "api")]

from urllib.parse import parse_qsl, urlencode  # noqa: E402

from sutra_api.main import app as _app  # noqa: E402

#: The query key `vercel.json` uses to carry the URL the client asked for. Vercel routes a rewrite to the
#: destination path, so without this the app would see "/api/index" for every request.
ORIGINAL_PATH_KEY = "__path"


async def app(scope, receive, send):
    """Put the requested path back before FastAPI routes it."""
    if scope["type"] == "http":
        query = parse_qsl(scope.get("query_string", b"").decode(), keep_blank_values=True)
        original = next((v for k, v in query if k == ORIGINAL_PATH_KEY), None)
        if original is not None:
            rest = [(k, v) for k, v in query if k != ORIGINAL_PATH_KEY]
            scope = {**scope, "path": original, "raw_path": original.encode(), "query_string": urlencode(rest).encode()}
    await _app(scope, receive, send)
