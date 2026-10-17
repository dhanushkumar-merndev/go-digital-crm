"""Entry point: connects to PIOPIY as our Voice AI agent and serves calls.

The PIOPIY Agent keeps one outbound Socket.IO connection to TeleCMI's signaling
server and starts a session for every call routed to AGENT_ID, so this process
needs no public URL. Calls run concurrently, one asyncio task each.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any

import aiohttp
from piopiy.agent import Agent

from .config import ConfigError, load_settings
from .crm import CrmClient
from .session import handle_call

logger = logging.getLogger("voice_agent")


async def serve() -> None:
    settings = load_settings()
    logging.basicConfig(
        level=logging.DEBUG if settings.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    async with aiohttp.ClientSession() as http:
        crm = CrmClient(settings.crm_edge_base_url, settings.ai_agent_service_secret, http)

        async def create_session(call_id: str | None = None, metadata: Any = None) -> None:
            logger.info("PIOPIY session %s started", call_id)
            await handle_call(settings, http, crm, metadata)

        agent = Agent(
            agent_id=settings.agent_id,
            agent_token=settings.agent_token,
            create_session=create_session,
            debug=settings.debug,
        )
        logger.info("connecting to PIOPIY as agent %s", settings.agent_id)
        await agent.connect()


def main() -> None:
    try:
        asyncio.run(serve())
    except ConfigError as error:
        print(f"voice-agent configuration error: {error}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
