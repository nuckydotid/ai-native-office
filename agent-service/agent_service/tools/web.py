"""The agent's window onto the team server: read-only calls to `/internal/v1/*` with an ID token for the server's address."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..auth import IdTokenSource

log = logging.getLogger("agent_service.web")


class WebError(Exception):
    pass


class WebClient:
    def __init__(
        self,
        base: str,
        *,
        tokens: IdTokenSource | None = None,
        auth: bool = True,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base = base.rstrip("/")
        self._tokens = tokens or IdTokenSource()
        self._auth = auth
        self._http = httpx.AsyncClient(timeout=timeout, transport=transport, follow_redirects=False)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        headers = {"accept": "application/json"}
        if self._auth:
            headers["authorization"] = f"Bearer {await self._tokens.get(self.base)}"
        clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        last: Exception | None = None
        for attempt in range(2):
            try:
                res = await self._http.get(f"{self.base}{path}", params=clean, headers=headers)
            except httpx.HTTPError as exc:
                last = exc
                continue
            if res.status_code == 404:
                return None
            if res.status_code >= 500 and attempt == 0:
                last = WebError(f"status {res.status_code}")
                continue
            if res.status_code >= 400:
                raise WebError(f"the team server answered {res.status_code}")
            return res.json()
        raise WebError(f"the team server could not be reached: {type(last).__name__ if last else '?'}")

    async def tickets(self, status: str = "", q: str = "") -> list[dict[str, Any]]:
        data = await self._get("/internal/v1/tickets", {"status": status, "q": q})
        return list((data or {}).get("tickets", []))

    async def ticket(self, key: int | str) -> dict[str, Any] | None:
        return await self._get(f"/internal/v1/tickets/{key}")

    async def pages(self, q: str = "") -> list[dict[str, Any]]:
        data = await self._get("/internal/v1/pages", {"q": q})
        return list((data or {}).get("pages", []))

    async def page(self, page_id: str) -> dict[str, Any] | None:
        return await self._get(f"/internal/v1/pages/{page_id}")

    async def messages(self, room: str = "", session: str = "", limit: int = 40) -> list[dict[str, Any]]:
        data = await self._get("/internal/v1/messages", {"room": room, "session": session, "limit": limit})
        return list((data or {}).get("messages", []))

    async def repo(self) -> dict[str, Any] | None:
        """The sample app's virtual trunk: its revision and the files a change set must be written against."""
        return await self._get("/internal/v1/repo")

    async def repo_file(self, path: str) -> str | None:
        data = await self._get("/internal/v1/repo/file", {"path": path})
        return str(data.get("content")) if data else None

    async def artifacts(self, ticket: str, kind: str = "") -> list[dict[str, Any]]:
        data = await self._get("/internal/v1/artifacts", {"ticket": ticket, "kind": kind})
        return list((data or {}).get("artifacts", []))

    async def artifact(self, artifact_id: str) -> dict[str, Any] | None:
        return await self._get(f"/internal/v1/artifacts/{artifact_id}")

    async def jobs(self, ticket: str) -> list[dict[str, Any]]:
        data = await self._get("/internal/v1/jobs", {"ticket": ticket})
        return list((data or {}).get("jobs", []))

    async def job_log(self, job_id: str) -> dict[str, Any] | None:
        return await self._get(f"/internal/v1/jobs/{job_id}/log")

    async def rollouts(self, ticket: str) -> list[dict[str, Any]]:
        data = await self._get("/internal/v1/rollouts", {"ticket": ticket})
        return list((data or {}).get("rollouts", []))
