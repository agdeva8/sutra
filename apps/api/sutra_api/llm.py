"""The model seam for the routes that need a plain structured completion.

Backed by agentv2, so the service has one model configuration (agentv2's `config.py` and
`.env`) and no dependency on the v1 agent. `get_complete()` keeps the signature the chat,
sources and refine routes already call: `await complete(system, user, schema) -> schema`.

The model call blocks, so it runs in a thread rather than freezing the server.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

from agentv2 import default_chat
from agentv2.config import load_settings
from agentv2.llm import complete_json
from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)
CompleteFn = Callable[[str, str, type[T]], Awaitable[T]]

PROVIDER_NAME = "deepseek"

__all__ = ["CompleteFn", "LlmError", "get_complete", "provider_configured", "provider_status"]


class LlmError(RuntimeError):
    """The model was unreachable or its reply could not be read into the requested shape."""


async def _complete(system: str, user: str, schema: type[T]) -> T:
    result = await asyncio.to_thread(complete_json, default_chat(), system, user, schema)
    if result is None:
        raise LlmError("The model's reply could not be read.")
    return result


def get_complete() -> CompleteFn:
    return _complete


def _settings():
    try:
        return load_settings()
    except SystemExit:  # no key configured
        return None


def provider_status() -> dict:
    """`{"provider", "model", "endpoint", "real"}`. `real` is False when no key is configured."""
    cfg = _settings()
    if cfg is None:
        return {"provider": "none", "model": "", "endpoint": "", "real": False}
    return {"provider": PROVIDER_NAME, "model": cfg.model, "endpoint": cfg.base_url, "real": True}


def provider_configured() -> bool:
    return _settings() is not None
