"""Builds what the agent says and how it behaves from the CRM call context."""

from __future__ import annotations

from typing import Any

from .languages import CallLanguage

# What each CRM field means, for the model that asks and the one that extracts.
FIELD_HINTS: dict[str, str] = {
    "interested_model": "the car model the customer wants (text)",
    "variant": "the variant or trim of that model (text)",
    "purchase_timeline": "when they plan to buy, e.g. 'this month', '2-3 months' (text)",
    "budget_max": "their maximum budget in rupees (number, e.g. 1200000)",
    "finance_required": "whether they need a car loan (true/false)",
    "exchange_required": "whether they want to exchange an old vehicle (true/false)",
    "test_drive_required": "whether they want a test drive (true/false)",
    "temperature": "HOT if ready to buy soon, WARM if interested, COLD if just exploring",
    "not_interested": "the reason they are not interested (text), only if they are not",
}

OUTCOMES = (
    "ANSWERED_QUALIFIED",
    "CALLBACK_REQUESTED",
    "NOT_INTERESTED",
    "DO_NOT_CALL",
    "WRONG_NUMBER",
    "NO_RESPONSE",
    "VOICEMAIL",
    "FAILED",
)

# Outcomes the agent may choose when it ends the call itself.
AGENT_OUTCOMES = OUTCOMES[:5]


def _text(value: Any, limit: int) -> str:
    return str(value).strip()[:limit] if isinstance(value, str) else ""


def questions(script: dict[str, Any]) -> list[dict[str, str]]:
    result = []
    for item in script.get("questions") or []:
        if isinstance(item, dict) and _text(item.get("ask"), 300):
            field = item.get("field") if isinstance(item.get("field"), str) else ""
            result.append({"ask": _text(item.get("ask"), 300), "field": field})
    return result


def greeting(context: dict[str, Any]) -> str:
    """The opening line in English; translated for other languages before the call."""
    script = context.get("script") or {}
    name = _text(context.get("customer_first_name"), 40)
    agent = _text(script.get("agent_name"), 40) or "the assistant"
    dealership = _text(context.get("dealership_name"), 80) or "the dealership"
    intro = _text(script.get("intro"), 400)
    hello = f"Hello {name}," if name else "Hello,"
    parts = [
        f"{hello} this is {agent}, an automated assistant calling from {dealership}.",
        intro,
        "Is this a good time to talk for a minute?",
    ]
    return " ".join(part for part in parts if part)


def closing(context: dict[str, Any]) -> str:
    script = context.get("script") or {}
    custom = _text(script.get("closing"), 400)
    if custom:
        return custom
    executive = _text(context.get("executive_first_name"), 40)
    who = f"Our executive {executive}" if executive else "Our executive"
    return f"Thank you for your time. {who} will get in touch with you soon. Have a nice day!"


def instructions(
    context: dict[str, Any], language: CallLanguage, allowed: list[CallLanguage]
) -> str:
    script = context.get("script") or {}
    agent = _text(script.get("agent_name"), 40) or "the assistant"
    dealership = _text(context.get("dealership_name"), 80) or "the dealership"
    branch = _text(context.get("branch_name"), 80)
    model = _text(context.get("interested_model"), 80)
    source = _text(context.get("source"), 40)
    executive = _text(context.get("executive_first_name"), 40)
    goal = _text(script.get("goal"), 800)
    question_lines = "\n".join(
        f"{index}. {item['ask']}"
        + (f"  (records {item['field']}: {FIELD_HINTS[item['field']]})" if item["field"] in FIELD_HINTS else "")
        for index, item in enumerate(questions(script), start=1)
    )
    other_languages = " or ".join(lang.name for lang in allowed if lang.code != language.code)
    enquiry = []
    if model:
        enquiry.append(f"They enquired about the {model}")
    if source:
        enquiry.append(f"through {source}")
    enquiry_text = " ".join(enquiry) + "." if enquiry else "They made a car enquiry."

    return f"""You are {agent}, an automated phone assistant for {dealership}{f" ({branch})" if branch else ""}, a car dealership in India.
You are on a live phone call with a customer who made an enquiry. {enquiry_text}
You already told them you are an automated assistant; never claim to be a human.

Goal: {goal}

Ask these questions, one at a time, in a natural order:
{question_lines}

How to speak:
- Speak only {language.name}. Keep each reply to one or two short sentences, as people do on the phone.
- Ask one question at a time and wait for the answer. Do not repeat a question that was answered.
- Say numbers and prices the way people say them in India (lakh, crore).
- Never invent prices, offers, discounts, stock or delivery dates. If asked, say {executive or "our sales executive"} will share the details.
{f"- If the customer asks for {other_languages}, call switch_language and continue in that language." if other_languages else ""}

When to end the call (always by calling end_call, never by just saying goodbye):
- All questions are answered: end_call with outcome ANSWERED_QUALIFIED.
- They are busy or ask to be called later: ask for a convenient time, then end_call with CALLBACK_REQUESTED.
- They are not interested: thank them, then end_call with NOT_INTERESTED.
- They ask not to be called again: apologise, then end_call with DO_NOT_CALL.
- You reached the wrong person: apologise, then end_call with WRONG_NUMBER.
end_call speaks the closing line for you, so do not say goodbye yourself."""
