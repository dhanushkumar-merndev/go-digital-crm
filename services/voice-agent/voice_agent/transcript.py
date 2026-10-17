"""Turns the LLM conversation context into speaker turns for the CRM."""

from __future__ import annotations

from typing import Any, Iterable

MAX_TURNS = 400
MAX_TURN_CHARS = 4000


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        ]
        return " ".join(text.strip() for text in parts if isinstance(text, str) and text.strip())
    return ""


def turns_from_messages(messages: Iterable[Any], greeting: str | None = None) -> list[dict[str, str]]:
    """Agent and customer lines in order; system prompts and tool traffic are left out."""
    turns: list[dict[str, str]] = []
    if greeting and greeting.strip():
        turns.append({"speaker": "AGENT", "text": greeting.strip()[:MAX_TURN_CHARS]})
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role not in ("user", "assistant") or message.get("tool_calls"):
            continue
        text = _content_text(message.get("content"))
        if not text:
            continue
        speaker = "AGENT" if role == "assistant" else "CUSTOMER"
        if turns and turns[-1]["speaker"] == speaker:
            merged = f"{turns[-1]['text']} {text}"
            turns[-1]["text"] = merged[:MAX_TURN_CHARS]
        else:
            turns.append({"speaker": speaker, "text": text[:MAX_TURN_CHARS]})
    return turns[:MAX_TURNS]


def customer_spoke(turns: list[dict[str, str]]) -> bool:
    return any(turn["speaker"] == "CUSTOMER" for turn in turns)
