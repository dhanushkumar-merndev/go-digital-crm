from voice_agent import prompt
from voice_agent.languages import LANGUAGES, allowed, resolve

CONTEXT = {
    "customer_first_name": "Ravi",
    "dealership_name": "Demo Motors",
    "branch_name": "MG Road",
    "interested_model": "Creta",
    "source": "Facebook",
    "executive_first_name": "Anita",
    "script": {
        "agent_name": "Priya",
        "goal": "Find out which car they want and when they will buy.",
        "languages": ["en-IN", "kn-IN"],
        "default_language": "en-IN",
        "questions": [
            {"id": "model", "ask": "Which model do you like?", "field": "interested_model"},
            {"id": "budget", "ask": "What is your budget?", "field": "budget_max"},
            {"id": "free", "ask": "Anything else?", "field": None},
        ],
    },
}


def test_greeting_discloses_automation_and_names_dealership():
    text = prompt.greeting(CONTEXT)
    assert "automated assistant" in text
    assert "Demo Motors" in text and "Ravi" in text


def test_instructions_carry_questions_language_and_end_rules():
    text = prompt.instructions(CONTEXT, LANGUAGES["kn-IN"], allowed(CONTEXT["script"]))
    assert "Speak only Kannada" in text
    assert "1. Which model do you like?" in text
    assert "budget_max" in text
    assert "DO_NOT_CALL" in text
    assert "If the customer asks for English, call switch_language" in text
    assert "Never invent prices" in text


def test_single_language_script_has_no_switching():
    script = {**CONTEXT["script"], "languages": ["en-IN"]}
    text = prompt.instructions({**CONTEXT, "script": script}, LANGUAGES["en-IN"], allowed(script))
    assert "switch_language" not in text


def test_closing_uses_script_or_executive():
    assert "Anita" in prompt.closing(CONTEXT)
    custom = {**CONTEXT, "script": {**CONTEXT["script"], "closing": "Bye from Demo!"}}
    assert prompt.closing(custom) == "Bye from Demo!"


def test_language_resolution():
    assert resolve("ml-IN").deepgram_language is None
    assert resolve("xx").code == "en-IN"
    assert [lang.code for lang in allowed({"languages": ["ta-IN", "bad"]})] == ["ta-IN"]
