"""The model seam — a thin re-export, deliberately not an implementation.

**The LLM lives inside `apps/agent`.** HLD §18 locks that: `app/llm/client.py` is
the only LLM seam, written so it can be lifted into a shared package later
without touching node code. This module exists so the service has one import for
"is a model available", and adds nothing to it.

Re-exporting rather than wrapping matters: if the service grew its own provider
resolution, the agent and the service could disagree about which model is
configured, and the failure would be a planner that silently runs on the offline
stub while the chat runs on DeepSeek.
"""
from __future__ import annotations

from app.llm.client import CompleteFn, LlmError, get_complete, resolve_provider

__all__ = [
    "CompleteFn",
    "LlmError",
    "get_complete",
    "provider_configured",
    "provider_status",
]


def provider_status() -> dict:
    """`{"provider", "model", "endpoint", "real"}`.

    `real` is False when nothing is configured — in which case the agent's
    deterministic offline stub serves every stage. That is a supported mode, not
    a degraded one: it is how the whole pipeline runs with no keys and no
    network, and every test in `apps/agent` uses it.
    """
    cfg = resolve_provider()
    if cfg is None:
        return {"provider": "stub", "model": "stub", "endpoint": "", "real": False}
    # `ProviderConfig` is the agent's own type; read defensively so a field added
    # or renamed there cannot break this service's readiness probe.
    return {
        "provider": getattr(cfg, "name", None) or getattr(cfg, "provider", "unknown"),
        "model": getattr(cfg, "model", ""),
        "endpoint": getattr(cfg, "base_url", None) or getattr(cfg, "url", ""),
        "real": True,
    }


def provider_configured() -> bool:
    """True when a real provider is resolvable.

    Note this is *not* "can the service produce completions" — the stub always
    can. Use it only where a real model is required.
    """
    return resolve_provider() is not None
