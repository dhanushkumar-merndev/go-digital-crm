import pytest

from voice_agent.config import ConfigError, load_settings

BASE = {
    "AGENT_ID": "agent",
    "AGENT_TOKEN": "token",
    "GROQ_API_KEY": "g",
    "DEEPGRAM_API_KEY": "d",
    "SARVAM_API_KEY": "s",
    "CRM_EDGE_BASE_URL": "https://ref.supabase.co/functions/v1/",
    "AI_AGENT_SERVICE_SECRET": "x" * 32,
}


def test_loads_and_trims_base_url():
    settings = load_settings(BASE)
    assert settings.crm_edge_base_url == "https://ref.supabase.co/functions/v1"
    assert settings.groq_model == "llama-3.3-70b-versatile"


@pytest.mark.parametrize(
    "override",
    [
        {"AGENT_TOKEN": ""},
        {"AI_AGENT_SERVICE_SECRET": "short"},
        {"CRM_EDGE_BASE_URL": "http://example.com"},
    ],
)
def test_rejects_unsafe_configuration(override):
    with pytest.raises(ConfigError):
        load_settings({**BASE, **override})
