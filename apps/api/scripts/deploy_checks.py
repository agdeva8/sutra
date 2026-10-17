"""Read-only checks the deploy workflow runs before it touches anything.

    cd apps/api && .venv/bin/python scripts/deploy_checks.py where
    cd apps/api && .venv/bin/python scripts/deploy_checks.py blocks-empty

`where` answers the question the first serverless deploy raises. The API is a
Vercel function in one region; the database is a Supabase instance which may be
in another, and every query then pays a transatlantic round trip. Which region
the database is in is readable from the pooler's hostname, so this prints the
host (never the user or password), the region, and the Vercel region code that
would sit next to it — warning when `vercel.json` names something else.

`blocks-empty` gates the one-time copy from the old tables: `backfill_blocks.py`
only writes while `calendar_blocks` is still empty, and this is how the workflow
asks that question and gets an exit code back.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import text

from sutra_api.config import settings
from sutra_api.db import create_engine

#: Supabase's pooler hostname, `aws-<n>-<region>.pooler.supabase.com`, carries
#: the database's region in its middle label. The session pooler (port 5432) and
#: the transaction pooler (6543) share the shape, so one pattern reads both.
POOLER_HOST_RE = re.compile(
    r"^aws-\d+-(?P<region>[a-z0-9-]+)\.pooler\.supabase\.com$"
)

#: Supabase region -> the Vercel region nearest it. Vercel has no region in every
#: cloud region, so this is a proximity map, not an identity: `ap-south-1` (AWS
#: Mumbai) is served from Vercel's `bom1`.
DB_REGION_TO_VERCEL_REGION = {
    "ap-northeast-1": "hnd1",
    "ap-northeast-2": "icn1",
    "ap-south-1": "bom1",
    "ap-southeast-1": "sin1",
    "ap-southeast-2": "syd1",
    "us-east-1": "iad1",
    "us-east-2": "cle1",
    "us-west-1": "sfo1",
    "us-west-2": "pdx1",
    "eu-west-1": "dub1",
    "eu-west-2": "lhr1",
    "eu-west-3": "cdg1",
    "eu-central-1": "fra1",
    "eu-north-1": "arn1",
    "sa-east-1": "gru1",
}

#: Where Vercel runs a function when a project sets no `regions`. A database in
#: this region needs no config change, which is why the warning below is skipped
#: rather than fired when the two already agree.
VERCEL_DEFAULT_REGION = "iad1"

#: The repo-root project config. Resolved from this file, not from the working
#: directory, so the check reads the same file wherever it is run from.
VERCEL_CONFIG_PATH = Path(__file__).resolve().parents[3] / "vercel.json"


def _host(url: str) -> str:
    """The hostname alone — no user, no password, no port, no database name."""
    return urlparse(url).hostname or ""


def _vercel_regions() -> list[str] | None:
    """`regions` from the repo-root vercel.json, or None when it names none."""
    try:
        config = json.loads(VERCEL_CONFIG_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    regions = config.get("regions")
    return regions if isinstance(regions, list) and regions else None


def cmd_where() -> int:
    """Print the database host, its region, and whether vercel.json matches."""
    host = _host(settings.ddl_url)
    print(f"database host: {host or '(unreadable)'}")

    match = POOLER_HOST_RE.match(host)
    if not match:
        # Local Docker Postgres, or a direct connection: there is no region to
        # compare, and no advice to give.
        print("not a Supabase pooler host — no region to compare")
        return 0

    db_region = match.group("region")
    print(f"database region: {db_region}")

    code = DB_REGION_TO_VERCEL_REGION.get(db_region)
    if code is None:
        print(
            f"no Vercel region mapped for {db_region} — add it to "
            "DB_REGION_TO_VERCEL_REGION in scripts/deploy_checks.py"
        )
        return 0

    print(f"nearest Vercel region: {code}")
    regions = _vercel_regions()
    if regions and code in regions:
        print("vercel.json already pins the API to the database's region")
        return 0
    if not regions and code == VERCEL_DEFAULT_REGION:
        # An absent `regions` means Vercel's default, and the default is already
        # the region we want. Nothing to warn about.
        print("vercel.json sets no regions; Vercel's default is already this region")
        return 0

    # A GitHub annotation, so the mismatch shows on the run itself and not only
    # in a log nobody opens.
    running_in = regions[0] if regions else f"Vercel's default {VERCEL_DEFAULT_REGION}"
    print(
        f"::warning::API runs in {running_in} but the database is in {db_region}; "
        f'set "regions": ["{code}"] in vercel.json'
    )
    return 0


async def _blocks_state() -> tuple[bool, str]:
    """(should the backfill run, the one line to print)."""
    engine = create_engine()
    try:
        async with engine.connect() as conn:
            exists = await conn.scalar(
                text("SELECT to_regclass('public.calendar_blocks') IS NOT NULL")
            )
            if not exists:
                return False, "calendar_blocks does not exist yet"
            rows = await conn.scalar(text("SELECT count(*) FROM calendar_blocks"))
            if rows:
                return False, f"calendar_blocks already holds {rows} rows"
            return True, "calendar_blocks exists and is empty"
    finally:
        await engine.dispose()


#: `blocks-empty` exit codes. An error must not read as "already copied": the workflow would then
#: skip the one-time backfill and deploy code that reads an empty table.
EXIT_EMPTY = 0
EXIT_HAS_ROWS = 1
EXIT_ERROR = 2


def cmd_blocks_empty() -> int:
    """EXIT_EMPTY while the table is empty and the one-time copy should run, EXIT_HAS_ROWS once it
    holds rows (or does not exist yet), EXIT_ERROR when the database could not be read."""
    try:
        should_backfill, line = asyncio.run(_blocks_state())
    except Exception as exc:  # noqa: BLE001 — any failure is reported as its own exit code
        print(f"could not read calendar_blocks: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_ERROR
    print(line)
    return EXIT_EMPTY if should_backfill else EXIT_HAS_ROWS


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("where", help="print the database host and its Vercel region")
    sub.add_parser(
        "blocks-empty",
        help="exit 0 while calendar_blocks has no rows (the backfill gate)",
    )
    args = parser.parse_args()

    return cmd_where() if args.command == "where" else cmd_blocks_empty()


if __name__ == "__main__":
    sys.exit(main())
