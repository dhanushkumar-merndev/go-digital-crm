from voice_agent.transcript import customer_spoke, turns_from_messages


def test_turns_skip_system_and_tool_traffic_and_merge_runs():
    messages = [
        {"role": "system", "content": "secret instructions"},
        {"role": "user", "content": "Hello?"},
        {"role": "user", "content": "Yes, tell me."},
        {"role": "assistant", "content": [{"type": "text", "text": "Which model?"}]},
        {"role": "assistant", "tool_calls": [{"id": "1"}], "content": None},
        {"role": "tool", "content": "{\"ok\": true}"},
        {"role": "user", "content": "Creta"},
    ]
    turns = turns_from_messages(messages, greeting="Hello Ravi")
    assert turns == [
        {"speaker": "AGENT", "text": "Hello Ravi"},
        {"speaker": "CUSTOMER", "text": "Hello? Yes, tell me."},
        {"speaker": "AGENT", "text": "Which model?"},
        {"speaker": "CUSTOMER", "text": "Creta"},
    ]
    assert customer_spoke(turns)


def test_silence_is_not_a_conversation():
    assert not customer_spoke(turns_from_messages([], greeting="Hello"))
