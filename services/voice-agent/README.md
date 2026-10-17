# Voice agent (TeleCMI PIOPIY)

The AI that talks to customers on **AI agent** auto calls. TeleCMI supplies the
phone line, the number and a PIOPIY Voice AI agent ID. This service is the
orchestrator: it runs [`piopiy-ai`](https://github.com/telecmi/agents) (TeleCMI's
framework) with our own speech and language providers.

| Step                       | Provider                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Listening (speech to text) | Deepgram nova-3: English, Hindi (including Hinglish), Kannada, Tamil, Telugu. Sarvam saarika: Malayalam |
| Thinking                   | Groq (`GROQ_MODEL`, default `llama-3.3-70b-versatile`)                                                  |
| Speaking (text to speech)  | Sarvam bulbul, all six languages                                                                        |

## How a call flows

1. A telecaller switches **Auto call** on while the dealership's auto-call mode is
   **AI agent**. `auto-call-dispatch` claims one of their uncontacted New leads and
   calls `POST rest.piopiy.com/v3/voice/ai/call` with only the CRM call ID and a
   random context token as `variables`.
2. PIOPIY rings the customer and, once they answer, sends `join_room` to this
   process over its outbound Socket.IO connection. No public URL is needed.
3. The agent fetches the script and lead context from `ai-agent-call-context`. The
   request is signed and works only while the call is open.
4. It greets the customer, says up front that it is an automated assistant, asks
   the script's questions in the lead's language, and ends through `end_call`.
5. A second Groq pass reads the transcript and returns the outcome, an English
   summary and the answers. These are posted to `provider-ai-agent-result`.
6. The CRM stores the answers as **suggestions**. The telecaller applies them and
   verifies the call. Nothing the agent hears edits a lead directly.

Customer PII never travels through TeleCMI's metadata, and this service logs
only CRM call IDs.

## Deploy

1. Create the agent in [dashboard.piopiy.com](https://dashboard.piopiy.com) under
   **Voice AI Agents** and copy `AGENT_ID` and `AGENT_TOKEN`. The PIOPIY REST token
   for placing calls goes into the CRM's PIOPIY connection (Client Admin >
   Integrations), not here.
2. Generate one random secret of at least 32 characters. Set it both as the Render
   env var and as the Supabase Edge secret `AI_AGENT_SERVICE_SECRET`. Also set the
   Edge secret `PIOPIY_AI_AGENT_ID` to the agent ID, or enter the agent ID on the
   PIOPIY connection.
3. Deploy the `go-digital-voice-agent` worker from `render.yaml`. It needs a paid
   (always-on) plan. Fill in the env vars listed in `.env.example`.
4. Deploy the Edge functions `ai-agent-call-context`, `provider-ai-agent-result`,
   `provider-webhook-piopiy`, `auto-call-dispatch` and `integration-connect-piopiy`.

## Local run and tests

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp .env.example .env   # fill in, then export the values
python -m voice_agent.main
pytest
```

The code targets `piopiy-ai==0.6.1` (`VoiceAgent.Action`). Check
`voice_agent/session.py` before you upgrade the pin.
