"""The model boundary: one DeepSeek chat model, built from our own settings.

Deliberately not read from the ambient environment. `ChatDeepSeek` would pick up
`DEEPSEEK_API_KEY` on its own, but routing it through `Settings` keeps a single
source for the key, the endpoint and the model id — and lets a test redirect the
model without touching `os.environ`.
"""
from __future__ import annotations

from langchain_deepseek import ChatDeepSeek

from .config import LLM_MAX_RETRIES, PROVIDER_ANTHROPIC, Settings


def build_model(settings: Settings):
    """The chat model this agent runs on: DeepSeek, or Claude when `LLM_PROVIDER=anthropic`."""
    if settings.provider == PROVIDER_ANTHROPIC:
        from langchain_anthropic import ChatAnthropic  # only needed on this path

        return ChatAnthropic(model_name=settings.model, api_key=settings.api_key, max_tokens=settings.max_tokens,
                             timeout=settings.timeout_s, max_retries=LLM_MAX_RETRIES)
    return ChatDeepSeek(
        model_name=settings.model,
        api_key=settings.api_key,
        api_base=settings.base_url,
        max_tokens=settings.max_tokens,
        request_timeout=settings.timeout_s,
        max_retries=LLM_MAX_RETRIES,
    )
