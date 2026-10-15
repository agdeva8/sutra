"""One structured model call: send, parse, and repair once if the reply is unusable.

The prompt carries the real JSON schema so the model is told the shape instead of
guessing it. A reply that fails to parse gets `LLM_REPAIR_ROUNDS` more tries, each
carrying the validation error back. If it still fails, the caller gets `None` and
degrades (an unreadable reply must never become a crash).
"""
from __future__ import annotations

import base64
import json
import re
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from .config import LLM_REPAIR_ROUNDS

T = TypeVar("T", bound=BaseModel)

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def schema_text(model: type[BaseModel]) -> str:
    return json.dumps(model.model_json_schema(), separators=(",", ":"))


Image = tuple[bytes, str]  # (data, mime type)


def _user_content(user: str, images: list[Image] | None):
    """Plain text, or text plus images as OpenAI-style `image_url` parts."""
    if not images:
        return user
    parts: list[dict] = [{"type": "text", "text": user}]
    for data, mime in images:
        url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
        parts.append({"type": "image_url", "image_url": {"url": url}})
    return parts


def reply_text(content) -> str:
    """The text of a model reply. DeepSeek answers with a string; Claude can answer with a list of
    content blocks (text, and thinking when it is on), of which only the text blocks are the answer."""
    if isinstance(content, str):
        return content
    return "".join(b if isinstance(b, str) else b.get("text", "") for b in content if isinstance(b, (str, dict)) and (isinstance(b, str) or b.get("type", "text") == "text"))


def complete_json(chat, system: str, user: str, schema: type[T], images: list[Image] | None = None) -> T | None:
    """`chat` is any object with `.invoke(messages) -> .content` (a LangChain chat model)."""
    messages = [("system", system), ("user", _user_content(user, images))]
    for _ in range(1 + LLM_REPAIR_ROUNDS):
        content = reply_text(chat.invoke(messages).content)
        try:
            return schema.model_validate_json(_FENCE.sub("", content).strip())
        except (ValidationError, ValueError) as e:
            messages += [("assistant", content), ("user", f"That was not valid for the schema: {e}. Reply with only the corrected JSON.")]
    return None
