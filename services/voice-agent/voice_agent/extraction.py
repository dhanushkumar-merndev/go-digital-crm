"""Groq calls made outside the live conversation: translating the fixed lines
before the call, and reading the outcome and answers from the transcript after it.

Whatever the model returns is normalised here, and the database validates it
again, so a bad extraction can only drop a suggestion, never write a wrong field.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import aiohttp

from .languages import CallLanguage
from .prompt import FIELD_HINTS, OUTCOMES

logger = logging.getLogger(__name__)

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
BOOLEAN_FIELDS = {"finance_required", "exchange_required", "test_drive_required"}
TEXT_LIMITS = {"interested_model": 120, "variant": 80, "purchase_timeline": 60, "not_interested": 120}


async def _chat_json(
    session: aiohttp.ClientSession, api_key: str, model: str, system: str, user: str
) -> dict[str, Any]:
    async with session.post(
        GROQ_CHAT_URL,
        headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        json={
            "model": model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        },
        timeout=aiohttp.ClientTimeout(total=20),
    ) as response:
        response.raise_for_status()
        body = await response.json()
    content = body["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    return parsed if isinstance(parsed, dict) else {}


async def translate_lines(
    session: aiohttp.ClientSession,
    api_key: str,
    model: str,
    language: CallLanguage,
    lines: dict[str, str],
) -> dict[str, str]:
    """Spoken lines in the call language. Falls back to the English lines."""
    if language.code == "en-IN":
        return lines
    try:
        translated = await _chat_json(
            session,
            api_key,
            model,
            "Translate each value of the JSON object into natural, polite spoken "
            f"{language.name} as used on a phone call in India, written in {language.name} script. "
            "Keep names, brand and car model names as they are. Return the same keys.",
            json.dumps(lines, ensure_ascii=False),
        )
    except (aiohttp.ClientError, KeyError, ValueError, TimeoutError) as error:
        logger.warning("translation to %s failed: %s", language.code, type(error).__name__)
        return lines
    return {
        key: translated[key].strip()
        if isinstance(translated.get(key), str) and translated[key].strip()
        else value
        for key, value in lines.items()
    }


def normalise_answers(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    answers: dict[str, Any] = {}
    for field, value in raw.items():
        if field not in FIELD_HINTS or value is None:
            continue
        if field in BOOLEAN_FIELDS:
            if isinstance(value, bool):
                answers[field] = value
            elif isinstance(value, str) and value.strip().lower() in {"true", "yes"}:
                answers[field] = True
            elif isinstance(value, str) and value.strip().lower() in {"false", "no"}:
                answers[field] = False
        elif field == "budget_max":
            try:
                amount = int(float(value))
            except (TypeError, ValueError):
                continue
            if 10_000 <= amount <= 1_000_000_000:
                answers[field] = amount
        elif field == "temperature":
            if isinstance(value, str) and value.strip().upper() in {"HOT", "WARM", "COLD"}:
                answers[field] = value.strip().upper()
        elif isinstance(value, str) and value.strip():
            answers[field] = value.strip()[: TEXT_LIMITS[field]]
    return answers


def normalise_result(raw: dict[str, Any], outcome_hint: str | None) -> dict[str, Any]:
    outcome = outcome_hint if outcome_hint in OUTCOMES else None
    if outcome is None:
        candidate = str(raw.get("outcome") or "").strip().upper()
        outcome = candidate if candidate in OUTCOMES else "ANSWERED_QUALIFIED"
    summary = raw.get("summary")
    return {
        "outcome": outcome,
        "summary": summary.strip()[:4000] if isinstance(summary, str) and summary.strip() else None,
        "answers": normalise_answers(raw.get("answers")),
    }


async def extract_result(
    session: aiohttp.ClientSession,
    api_key: str,
    model: str,
    turns: list[dict[str, str]],
    outcome_hint: str | None,
) -> dict[str, Any]:
    """Outcome, English summary and answers from the finished conversation."""
    transcript = "\n".join(f"{turn['speaker']}: {turn['text']}" for turn in turns)
    fields = "\n".join(f"- {name}: {hint}" for name, hint in FIELD_HINTS.items())
    system = (
        "You read the transcript of a car dealership's automated qualification call in India "
        "and return JSON with keys outcome, summary and answers.\n"
        f"outcome is one of: {', '.join(OUTCOMES)}. VOICEMAIL if a machine or voicemail "
        "answered; NO_RESPONSE if the customer never really spoke.\n"
        "summary: two or three plain English sentences for the sales team.\n"
        "answers: only fields the customer clearly stated; leave out anything unsure.\n"
        f"Fields:\n{fields}"
    )
    try:
        raw = await _chat_json(session, api_key, model, system, transcript[:60_000])
    except (aiohttp.ClientError, KeyError, ValueError, TimeoutError) as error:
        logger.warning("extraction failed: %s", type(error).__name__)
        raw = {}
    return normalise_result(raw, outcome_hint)
