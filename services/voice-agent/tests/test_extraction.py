from voice_agent.extraction import normalise_answers, normalise_result


def test_answers_are_normalised_and_unknown_or_invalid_values_dropped():
    answers = normalise_answers(
        {
            "interested_model": "  Creta ",
            "budget_max": "1500000",
            "finance_required": "yes",
            "test_drive_required": True,
            "temperature": "hot",
            "exchange_required": "maybe",
            "phone": "9876543210",
            "variant": "",
        }
    )
    assert answers == {
        "interested_model": "Creta",
        "budget_max": 1500000,
        "finance_required": True,
        "test_drive_required": True,
        "temperature": "HOT",
    }


def test_budget_outside_range_is_dropped():
    assert normalise_answers({"budget_max": 500}) == {}


def test_agent_outcome_wins_over_extraction():
    result = normalise_result({"outcome": "NOT_INTERESTED", "summary": " ok "}, "CALLBACK_REQUESTED")
    assert result["outcome"] == "CALLBACK_REQUESTED"
    assert result["summary"] == "ok"


def test_unknown_extracted_outcome_falls_back():
    assert normalise_result({"outcome": "GREAT"}, None)["outcome"] == "ANSWERED_QUALIFIED"
    assert normalise_result({"outcome": "voicemail"}, None)["outcome"] == "VOICEMAIL"
