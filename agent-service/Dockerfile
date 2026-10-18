# studio-agents: the Python ADK service (FastAPI + a streaming /v1/run) on Cloud Run.
# Private: only studio-web may call it, with a Google-signed ID token; it holds no secret.
# Build context is agent-service/ (deploy/deploy.sh does this in Cloud Build).

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY pyproject.toml ./
COPY agent_service agent_service
# Runtime dependencies only ([dev] and the tests stay out of the image).
RUN pip install .

RUN useradd --create-home --uid 10001 studio
USER studio

# Cloud Run sets PORT itself; the shell expands it. Every setting is read from the environment at startup.
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn agent_service.main:app_factory --factory --host 0.0.0.0 --port ${PORT}"]
