"""Service-to-service auth, both directions, with Google-signed ID tokens.

Incoming: `Authorization: Bearer <ID token>`; the audience must be this service's URL and the caller's email must be `ALLOWED_CALLER`.
Outgoing: tool calls to the team server carry an ID token for the team server's address. `AUTH_MODE=none` skips both for local work.
"""

from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlparse

from fastapi import HTTPException, Request

from .config import Settings

log = logging.getLogger("agent_service.auth")


class IdTokenSource:
    """ID tokens for calling another service, cached until shortly before they expire. Uses the runtime's service account
    (the metadata server on Cloud Run; Application Default Credentials elsewhere), never a key file."""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[str, float]] = {}
        self._lock = asyncio.Lock()

    async def get(self, audience: str) -> str:
        async with self._lock:
            hit = self._cache.get(audience)
            if hit and hit[1] - time.time() > 300:
                return hit[0]
            token = await asyncio.to_thread(self._fetch, audience)
            self._cache[audience] = (token, time.time() + 3000)
            return token

    @staticmethod
    def _fetch(audience: str) -> str:
        from google.auth.transport.requests import Request as GoogleRequest
        from google.oauth2 import id_token

        return id_token.fetch_id_token(GoogleRequest(), audience)


def verify_caller_token(token: str, settings: Settings) -> dict:
    """Checks a Google ID token: signature, issuer, expiry, audience = this service, email verified and equal to `ALLOWED_CALLER`."""
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2 import id_token

    if not settings.service_url or not settings.allowed_caller:
        # Fail closed: without an audience and a caller to compare against, nobody gets in.
        raise HTTPException(status_code=503, detail="auth is not configured (SERVICE_URL and ALLOWED_CALLER)")
    try:
        claims = id_token.verify_oauth2_token(token, GoogleRequest(), audience=settings.service_url)
    except Exception as exc:  # noqa: BLE001 - every failure is the same answer
        log.info("rejected an ID token: %s", type(exc).__name__)
        raise HTTPException(status_code=401, detail="invalid token") from exc
    email = str(claims.get("email", "")).lower()
    if not claims.get("email_verified") or email != settings.allowed_caller:
        raise HTTPException(status_code=403, detail="caller not allowed")
    return claims


def require_caller(settings: Settings):
    """A FastAPI dependency. `AUTH_MODE=none` lets everything through (local development only)."""

    async def dep(request: Request) -> None:
        if settings.auth_mode == "none":
            return
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="missing bearer token")
        await asyncio.to_thread(verify_caller_token, token.strip(), settings)

    return dep


def check_web_base(url: str, settings: Settings) -> str:
    """The team server's address from a run request, checked before we send it a token: http(s) only, no cloud-metadata or
    link-local hosts, and https unless auth is off (local development)."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        raise ValueError("webBase must be an http(s) address")
    if host in {"metadata.google.internal", "metadata"} or host.startswith("169.254."):
        raise ValueError("webBase points at a metadata address")
    if settings.auth_mode != "none" and parsed.scheme != "https":
        raise ValueError("webBase must be https when auth is on")
    allowed = [x for x in (settings.extra.get("ALLOWED_WEB_BASES", "")).split(",") if x.strip()]
    if allowed and url.rstrip("/") not in {a.strip().rstrip("/") for a in allowed}:
        raise ValueError("webBase is not on the allow-list")
    return url.rstrip("/")
