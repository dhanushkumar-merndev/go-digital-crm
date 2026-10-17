"""Signed calls to the CRM edge functions.

Both endpoints check `x-ai-agent-signature: sha256=HMAC(secret, f"{timestamp}.{body}")`
(see supabase/functions/_shared/ai-agent.ts). The body is serialised once and
the exact bytes that were signed are the bytes that are sent.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")


class CrmError(RuntimeError):
    def __init__(self, code: str, status: int | None = None, retryable: bool = False):
        super().__init__(code)
        self.code = code
        self.status = status
        self.retryable = retryable


def signed_request(secret: str, payload: dict[str, Any], now: float | None = None):
    """Returns (body bytes, headers) for one signed request."""
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    timestamp = str(int(time.time() if now is None else now))
    digest = hmac.new(
        secret.encode("utf-8"), f"{timestamp}.{body}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    headers = {
        "content-type": "application/json",
        "x-ai-agent-timestamp": timestamp,
        "x-ai-agent-signature": f"sha256={digest}",
    }
    return body.encode("utf-8"), headers


def call_reference(metadata: Any) -> tuple[str, str] | None:
    """The CRM call id and context token PIOPIY passed through, if both are valid."""
    if not isinstance(metadata, dict):
        return None
    call_id = str(metadata.get("crm_call_id") or "").strip()
    token = str(metadata.get("context_token") or "").strip()
    if not UUID_PATTERN.match(call_id) or not TOKEN_PATTERN.match(token):
        return None
    return call_id, token


class CrmClient:
    def __init__(self, base_url: str, secret: str, session: aiohttp.ClientSession):
        self._base_url = base_url.rstrip("/")
        self._secret = secret
        self._session = session

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body, headers = signed_request(self._secret, payload)
        try:
            async with self._session.post(
                f"{self._base_url}/{path}",
                data=body,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as response:
                data = await response.json(content_type=None)
                code = data.get("code") if isinstance(data, dict) else None
                if response.status >= 400:
                    raise CrmError(
                        str(code or f"HTTP_{response.status}"),
                        response.status,
                        retryable=response.status >= 500 or response.status == 429,
                    )
                return data if isinstance(data, dict) else {}
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            raise CrmError("CRM_UNREACHABLE", retryable=True) from error

    async def fetch_context(self, call_id: str, token: str) -> dict[str, Any]:
        payload = {"call_id": call_id, "context_token": token}
        for attempt in range(2):
            try:
                data = await self._post("ai-agent-call-context", payload)
                context = data.get("context")
                if not isinstance(context, dict):
                    raise CrmError("CONTEXT_MALFORMED")
                return context
            except CrmError as error:
                if not error.retryable or attempt == 1:
                    raise
                await asyncio.sleep(0.4)
        raise CrmError("CRM_UNREACHABLE")

    async def post_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Retries for about a minute: losing a result loses the conversation."""
        delay = 1.0
        for attempt in range(6):
            try:
                return await self._post("provider-ai-agent-result", payload)
            except CrmError as error:
                if not error.retryable or attempt == 5:
                    raise
                logger.warning(
                    "result post for call %s failed (%s), retrying", payload.get("call_id"), error.code
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, 20)
        raise CrmError("CRM_UNREACHABLE")
