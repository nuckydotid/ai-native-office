"""Auth: AUTH_MODE=none only locally, a Google ID token is required otherwise, and webBase is checked before a token is sent."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from agent_service.auth import check_web_base, require_caller

from .support import fake_settings


def request_with(headers: dict[str, str] | None = None) -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()],
    }
    return Request(scope)


async def test_auth_none_lets_local_calls_through():
    dep = require_caller(fake_settings(auth_mode="none"))
    assert await dep(request_with()) is None


async def test_google_mode_refuses_a_missing_token():
    dep = require_caller(fake_settings(auth_mode="google", service_url="https://agents.run.app", allowed_caller="web@x.iam.gserviceaccount.com"))
    with pytest.raises(HTTPException) as caught:
        await dep(request_with())
    assert caught.value.status_code == 401


async def test_google_mode_without_configuration_fails_closed():
    dep = require_caller(fake_settings(auth_mode="google"))
    with pytest.raises(HTTPException) as caught:
        await dep(request_with({"authorization": "Bearer whatever"}))
    assert caught.value.status_code == 503


def test_a_web_base_is_checked_before_a_token_is_sent():
    strict = fake_settings(auth_mode="google")
    assert check_web_base("https://studio-web-123.run.app/", strict) == "https://studio-web-123.run.app"
    with pytest.raises(ValueError):
        check_web_base("http://studio-web-123.run.app", strict)  # not https when auth is on
    assert check_web_base("http://127.0.0.1:8080", fake_settings(auth_mode="none")) == "http://127.0.0.1:8080"
    for bad in ("https://metadata.google.internal", "https://169.254.169.254", "ftp://x", "not a url"):
        with pytest.raises(ValueError):
            check_web_base(bad, strict)


def test_the_allow_list_refuses_an_address_that_is_not_on_it():
    allowed = fake_settings(auth_mode="google", extra={"ALLOWED_WEB_BASES": "https://a.run.app"})
    assert check_web_base("https://a.run.app", allowed) == "https://a.run.app"
    with pytest.raises(ValueError):
        check_web_base("https://b.run.app", allowed)
