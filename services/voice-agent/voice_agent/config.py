"""Environment configuration. Every value is server-side only."""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    agent_id: str
    agent_token: str
    groq_api_key: str
    deepgram_api_key: str
    sarvam_api_key: str
    crm_edge_base_url: str
    ai_agent_service_secret: str
    groq_model: str = "llama-3.3-70b-versatile"
    groq_extraction_model: str = "llama-3.3-70b-versatile"
    debug: bool = False


def _required(environ: dict[str, str], name: str) -> str:
    value = environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is not set")
    return value


def load_settings(environ: dict[str, str] | None = None) -> Settings:
    env = dict(os.environ if environ is None else environ)
    secret = _required(env, "AI_AGENT_SERVICE_SECRET")
    if len(secret) < 32:
        raise ConfigError("AI_AGENT_SERVICE_SECRET must be at least 32 characters")
    base_url = _required(env, "CRM_EDGE_BASE_URL").rstrip("/")
    if not base_url.startswith("https://") and not base_url.startswith("http://localhost"):
        raise ConfigError("CRM_EDGE_BASE_URL must be https")
    return Settings(
        agent_id=_required(env, "AGENT_ID"),
        agent_token=_required(env, "AGENT_TOKEN"),
        groq_api_key=_required(env, "GROQ_API_KEY"),
        deepgram_api_key=_required(env, "DEEPGRAM_API_KEY"),
        sarvam_api_key=_required(env, "SARVAM_API_KEY"),
        crm_edge_base_url=base_url,
        ai_agent_service_secret=secret,
        groq_model=env.get("GROQ_MODEL", "").strip() or Settings.groq_model,
        groq_extraction_model=env.get("GROQ_EXTRACTION_MODEL", "").strip()
        or Settings.groq_extraction_model,
        debug=env.get("AGENT_DEBUG", "").strip().lower() in {"1", "true", "yes"},
    )
