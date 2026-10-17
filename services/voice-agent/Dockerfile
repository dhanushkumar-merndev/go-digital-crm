FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY voice_agent ./voice_agent

RUN useradd --create-home --uid 10001 agent
USER agent

CMD ["python", "-m", "voice_agent.main"]
