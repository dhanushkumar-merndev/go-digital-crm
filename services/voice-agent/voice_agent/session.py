"""One phone call: fetch the CRM context, hold the conversation, report back.

Written against piopiy-ai 0.6.1 (pinned in requirements.txt). The pipeline is
Deepgram nova-3 (Sarvam saarika for Malayalam) -> Groq -> Sarvam bulbul, with
Silero VAD and barge-in. The conversation itself never writes to the CRM: when
it ends, the transcript is read from the LLM context, a second Groq pass pulls
out the outcome and answers, and one signed result is posted.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp
from deepgram import LiveOptions
from piopiy.adapters.schemas.function_schema import FunctionSchema
from piopiy.frames.frames import EndFrame, FunctionCallResultProperties, TTSSpeakFrame
from piopiy.pipeline.service_switcher import ServiceSwitcher, ServiceSwitcherStrategyManual
from piopiy.services.deepgram.stt import DeepgramSTTService
from piopiy.services.groq.llm import GroqLLMService
from piopiy.services.llm_service import FunctionCallParams
from piopiy.services.sarvam.stt import SarvamSTTService
from piopiy.services.sarvam.tts import SarvamTTSService
from piopiy.transcriptions.language import Language
from piopiy.voice_agent import VoiceAgent

from . import extraction, prompt
from .config import Settings
from .crm import CrmClient, CrmError, call_reference
from .languages import CallLanguage, allowed, resolve
from .transcript import customer_spoke, turns_from_messages

logger = logging.getLogger(__name__)

# How long the customer may stay silent before the call is closed.
IDLE_TIMEOUT_SECS = 25


def _stt(settings: Settings, language: CallLanguage):
    if language.deepgram_language is None:
        return SarvamSTTService(
            api_key=settings.sarvam_api_key,
            model="saarika:v2.5",
            params=SarvamSTTService.InputParams(language=Language(language.code)),
        )
    return DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        live_options=LiveOptions(
            model="nova-3",
            language=language.deepgram_language,
            smart_format=True,
            punctuate=True,
            interim_results=True,
        ),
    )


def _tts(settings: Settings, language: CallLanguage, voice: str | None):
    return SarvamTTSService(
        api_key=settings.sarvam_api_key,
        model="bulbul:v2",
        voice_id=voice or language.sarvam_speaker,
        params=SarvamTTSService.InputParams(language=Language(language.code.split("-")[0])),
    )


END_CALL = FunctionSchema(
    name="end_call",
    description="End the phone call. The closing line is spoken for you.",
    properties={
        "outcome": {
            "type": "string",
            "enum": list(prompt.AGENT_OUTCOMES),
            "description": "Why the call is ending.",
        }
    },
    required=["outcome"],
)


def _switch_language_schema(languages: list[CallLanguage]) -> FunctionSchema:
    return FunctionSchema(
        name="switch_language",
        description="Continue the call in another language the customer asked for.",
        properties={
            "language": {
                "type": "string",
                "enum": [language.code for language in languages],
                "description": "Language code, e.g. "
                + ", ".join(f"{lang.code} for {lang.name}" for lang in languages),
            }
        },
        required=["language"],
    )


class CallSession:
    def __init__(
        self,
        settings: Settings,
        http: aiohttp.ClientSession,
        crm: CrmClient,
        call_id: str,
        token: str,
        context: dict[str, Any],
    ) -> None:
        self.settings = settings
        self.http = http
        self.crm = crm
        self.call_id = call_id
        self.token = token
        self.context = context
        self.script: dict[str, Any] = context.get("script") or {}
        self.languages = allowed(self.script)
        self.language = resolve(context.get("language"), self.languages[0].code)
        self.outcome_hint: str | None = None
        # Greeting and closing per language, translated once per call.
        self.spoken_lines: dict[str, dict[str, str]] = {}
        self.agent: VoiceAgent | None = None
        self.ending = False

    async def _lines(self, language: CallLanguage) -> dict[str, str]:
        if language.code not in self.spoken_lines:
            self.spoken_lines[language.code] = await extraction.translate_lines(
                self.http,
                self.settings.groq_api_key,
                self.settings.groq_model,
                language,
                {"greeting": prompt.greeting(self.context), "closing": prompt.closing(self.context)},
            )
        return self.spoken_lines[language.code]

    async def _say_closing_and_end(self) -> None:
        if self.ending or not self.agent or not self.agent._task:
            return
        self.ending = True
        closing = (await self._lines(self.language))["closing"]
        # VoiceAgent has no public way to queue frames; its task is the pipeline.
        await self.agent._task.queue_frames([TTSSpeakFrame(closing), EndFrame()])

    async def _end_call(self, params: FunctionCallParams) -> None:
        outcome = str(params.arguments.get("outcome") or "").upper()
        self.outcome_hint = outcome if outcome in prompt.AGENT_OUTCOMES else "ANSWERED_QUALIFIED"
        await params.result_callback(
            {"ok": True}, properties=FunctionCallResultProperties(run_llm=False)
        )
        await self._say_closing_and_end()

    async def _switch_language(self, params: FunctionCallParams) -> None:
        target = resolve(params.arguments.get("language"), self.language.code)
        if target.code == self.language.code or target not in self.languages:
            await params.result_callback({"ok": False, "language": self.language.name})
            return
        stt, tts = self._services[target.code]
        assert self.agent is not None
        await self.agent.switch_service(stt)
        await self.agent.switch_service(tts)
        self.language = target
        await self._lines(target)
        await params.result_callback(
            {"ok": True, "language": target.name, "instruction": f"Speak only {target.name} now."}
        )

    async def _duration_guard(self, max_duration_sec: int) -> None:
        # Leave time for the closing line before PIOPIY cuts the call.
        await asyncio.sleep(max(max_duration_sec - 15, 30))
        logger.info("call %s reached its time limit", self.call_id)
        await self._say_closing_and_end()

    async def run(self) -> None:
        started = time.monotonic()
        greeting = (await self._lines(self.language))["greeting"]
        voice = self.script.get("voice") if isinstance(self.script.get("voice"), str) else None

        # Every allowed language gets its services up front so a switch is instant.
        self._services = {
            language.code: (_stt(self.settings, language), _tts(self.settings, language, voice))
            for language in self.languages
        }
        order = [self.language] + [lang for lang in self.languages if lang != self.language]
        llm = GroqLLMService(api_key=self.settings.groq_api_key, model=self.settings.groq_model)
        self.agent = VoiceAgent(
            instructions=prompt.instructions(self.context, self.language, self.languages),
            greeting=greeting,
            idle_timeout_secs=IDLE_TIMEOUT_SECS,
        )
        self.agent.add_tool(END_CALL, self._end_call)
        if len(self.languages) > 1:
            self.agent.add_tool(_switch_language_schema(self.languages), self._switch_language)
            await self.agent.Action(
                stt_switcher=ServiceSwitcher(
                    services=[self._services[lang.code][0] for lang in order],
                    strategy_type=ServiceSwitcherStrategyManual,
                ),
                tts_switcher=ServiceSwitcher(
                    services=[self._services[lang.code][1] for lang in order],
                    strategy_type=ServiceSwitcherStrategyManual,
                ),
                llm=llm,
                vad=True,
                allow_interruptions=True,
            )
        else:
            stt, tts = self._services[self.language.code]
            await self.agent.Action(stt=stt, tts=tts, llm=llm, vad=True, allow_interruptions=True)

        guard = asyncio.create_task(
            self._duration_guard(int(self.context.get("max_duration_sec") or 300))
        )
        try:
            await self.agent.start()
        finally:
            guard.cancel()

        messages = []
        if self.agent.context_aggregator is not None:
            messages = list(self.agent.context_aggregator.user().messages)
        turns = turns_from_messages(messages, greeting)
        await self._report(turns, int(time.monotonic() - started))

    async def _report(self, turns: list[dict[str, str]], duration_seconds: int) -> None:
        if not customer_spoke(turns):
            result = {"outcome": "NO_RESPONSE", "summary": None, "answers": {}}
        else:
            result = await extraction.extract_result(
                self.http,
                self.settings.groq_api_key,
                self.settings.groq_extraction_model,
                turns,
                self.outcome_hint,
            )
        payload = {
            "call_id": self.call_id,
            "context_token": self.token,
            "outcome": result["outcome"],
            "language": self.language.code,
            "summary": result["summary"],
            "answers": result["answers"],
            "turns": turns,
            "duration_seconds": duration_seconds,
        }
        response = await self.crm.post_result(payload)
        logger.info("call %s reported: %s (%s)", self.call_id, result["outcome"], response.get("code"))


async def handle_call(
    settings: Settings,
    http: aiohttp.ClientSession,
    crm: CrmClient,
    metadata: Any,
) -> None:
    """Runs one PIOPIY session. A call without valid CRM metadata is not ours."""
    reference = call_reference(metadata)
    if reference is None:
        logger.warning("session without CRM call metadata ignored")
        return
    call_id, token = reference
    try:
        context = await crm.fetch_context(call_id, token)
    except CrmError as error:
        logger.warning("call %s context unavailable: %s", call_id, error.code)
        return
    session = CallSession(settings, http, crm, call_id, token, context)
    try:
        await session.run()
    except CrmError as error:
        logger.error("call %s result not delivered: %s", call_id, error.code)
    except Exception:
        logger.exception("call %s failed", call_id)
        try:
            await crm.post_result(
                {"call_id": call_id, "context_token": token, "outcome": "FAILED", "turns": []}
            )
        except CrmError as error:
            logger.error("call %s failure not delivered: %s", call_id, error.code)
