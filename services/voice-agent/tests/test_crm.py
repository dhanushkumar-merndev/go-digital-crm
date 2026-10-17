import hashlib
import hmac
import json

from voice_agent.crm import call_reference, signed_request

SECRET = "s" * 40
TOKEN = "a" * 64
CALL_ID = "87bfa54c-64cb-4ec7-b7d4-1c5f9be77744"


def test_signature_matches_edge_function_scheme():
    body, headers = signed_request(SECRET, {"call_id": CALL_ID, "text": "ಕನ್ನಡ"}, now=1_760_000_000)
    assert headers["x-ai-agent-timestamp"] == "1760000000"
    expected = hmac.new(
        SECRET.encode(), b"1760000000." + body, hashlib.sha256
    ).hexdigest()
    assert headers["x-ai-agent-signature"] == f"sha256={expected}"
    # Non-ASCII stays UTF-8 in the signed body, as the Deno side reads it.
    assert json.loads(body.decode("utf-8"))["text"] == "ಕನ್ನಡ"


def test_call_reference_accepts_only_valid_metadata():
    assert call_reference({"crm_call_id": CALL_ID, "context_token": TOKEN}) == (CALL_ID, TOKEN)
    assert call_reference({"crm_call_id": "x", "context_token": TOKEN}) is None
    assert call_reference({"crm_call_id": CALL_ID, "context_token": "short"}) is None
    assert call_reference("not a dict") is None
    assert call_reference(None) is None
