"""`python -m agentv2.demo <step>` — run one build step's demo."""
from __future__ import annotations

import asyncio
import sys

from . import step1, step2, step3, step4, step5_done, step6_tick, step7_chat, step8_replan

STEPS = {"1": step1.run, "2": step2.run, "3": step3.run, "4": step4.run, "done": step5_done.run, "tick": step6_tick.run, "chat": step7_chat.run, "replan": step8_replan.run}

if __name__ == "__main__":
    asyncio.run(STEPS[sys.argv[1] if len(sys.argv) > 1 else "1"]())
