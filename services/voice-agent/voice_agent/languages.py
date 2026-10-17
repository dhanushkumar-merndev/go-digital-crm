"""The six call languages and which speech service handles each."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CallLanguage:
    code: str
    name: str
    # Deepgram nova-3 language, or None when Sarvam STT is used instead.
    deepgram_language: str | None
    # Sarvam bulbul speaker that suits this language.
    sarvam_speaker: str


# Deepgram nova-3 has no Malayalam, so that one listens through Sarvam.
# English and Hindi use nova-3 "multi", which follows Hinglish code-switching.
LANGUAGES: dict[str, CallLanguage] = {
    "en-IN": CallLanguage("en-IN", "English", "multi", "anushka"),
    "hi-IN": CallLanguage("hi-IN", "Hindi", "multi", "anushka"),
    "kn-IN": CallLanguage("kn-IN", "Kannada", "kn", "anushka"),
    "ta-IN": CallLanguage("ta-IN", "Tamil", "ta", "anushka"),
    "te-IN": CallLanguage("te-IN", "Telugu", "te", "anushka"),
    "ml-IN": CallLanguage("ml-IN", "Malayalam", None, "anushka"),
}


def resolve(code: object, fallback: str = "en-IN") -> CallLanguage:
    if isinstance(code, str) and code in LANGUAGES:
        return LANGUAGES[code]
    return LANGUAGES[fallback]


def allowed(script: dict) -> list[CallLanguage]:
    codes = script.get("languages") if isinstance(script, dict) else None
    result = [LANGUAGES[code] for code in codes or [] if code in LANGUAGES]
    return result or [LANGUAGES["en-IN"]]
