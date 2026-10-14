"""The nightly tick for every user, from a terminal or a scheduler:

    cd apps/api && .venv/bin/python scripts/agent_tick.py

On Vercel the same work runs from `GET /cron/tick`.
"""
import asyncio
import logging

from sutra_api.nightly import tick_all_users

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(asyncio.run(tick_all_users()))
