"""Python port of `scrubSecrets` (src/shared/workspace/secrets.ts): redacts things that look like credentials from text that is
about to be posted to a whole room. A safety net for a model's reply, not a security boundary: it only knows common shapes.

Every pattern is anchored on something specific and its repeats are bounded, so hostile text cannot make it slow. A replacement
may be longer than what it replaces; callers with a length limit check it again afterwards. Running it twice changes nothing.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

MARK = "[redacted]"

_I = re.IGNORECASE

# (pattern, replacement function over the match)
_RULES: list[tuple[re.Pattern[str], Callable[[re.Match[str]], str]]] = [
    # A private key block (PEM, or PGP's "... KEY BLOCK"), to its end, or to the end of the text if it was cut off.
    (
        re.compile(
            r"-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?"
            r"(?:-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|$)"
        ),
        lambda m: "[redacted key]",
    ),
    # A value of a secret-looking key, quoted: "client_secret": "...", refresh_token = '...'.
    (
        re.compile(
            r"(\b(?:client_secret|refresh_token|private_key|access_token|api[_-]?key|secret[_-]?key|auth[_-]?token)\b[\"']?\s*[:=]\s*[\"'])"
            r"[A-Za-z0-9._~/+=-]{16,512}([\"'])",
            _I,
        ),
        lambda m: m.group(1) + MARK + m.group(2),
    ),
    # The same without quotes, for the keys that are only ever secrets: refresh_token=1//0g...
    (
        re.compile(r"(\b(?:client_secret|refresh_token|access_token)\s*[:=]\s*)[A-Za-z0-9._~/+=-]{16,512}", _I),
        lambda m: m.group(1) + MARK,
    ),
    # A bearer token in a header.
    (re.compile(r"(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,2048}"), lambda m: m.group(1) + MARK),
    # A Google refresh token on its own.
    (re.compile(r"\b1//0[A-Za-z0-9_-]{20,512}"), lambda m: MARK),
    # A password inside an address: postgres://user:pass@host, redis://:pass@host. The password may itself contain an `@`.
    (re.compile(r"\b([a-z][a-z0-9+.-]{0,31}://)[^\s:@/]{0,256}:[^\s/]{1,512}@", _I), lambda m: m.group(1) + MARK + "@"),
    (re.compile(r"\bya29\.[A-Za-z0-9_-]{20,2048}"), lambda m: MARK),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), lambda m: MARK),
    (re.compile(r"\bGOCSPX-[A-Za-z0-9_-]{20,128}"), lambda m: MARK),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,255}"), lambda m: MARK),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,255}"), lambda m: MARK),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), lambda m: MARK),
    (re.compile(r"\bsk_live_[A-Za-z0-9]{16,255}"), lambda m: MARK),
    # `sk-...` keys always carry digits; ordinary hyphenated words (CSS class names) do not.
    (re.compile(r"\bsk-(?=[A-Za-z0-9_-]{0,255}\d)[A-Za-z0-9_-]{20,255}"), lambda m: MARK),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,255}"), lambda m: MARK),
    # A JSON web token (which is what a Google ID token is).
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}"),
        lambda m: MARK,
    ),
]


@dataclass(frozen=True)
class Scrubbed:
    text: str
    hits: int


def scrub_secrets(text: str) -> Scrubbed:
    """Redacts in place (never rejects) and says how many things it redacted."""
    out = text
    hits = 0
    for pattern, replace in _RULES:

        def sub(m: re.Match[str], replace: Callable[[re.Match[str]], str] = replace) -> str:
            nonlocal hits
            hits += 1
            return replace(m)

        out = pattern.sub(sub, out)
    return Scrubbed(out, hits)


def scrub(text: str) -> str:
    return scrub_secrets(text).text


def scrub_deep(value: object) -> object:
    """Scrubs every string inside a JSON-like value (cards, citations), keeping its shape."""
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, list):
        return [scrub_deep(v) for v in value]
    if isinstance(value, dict):
        return {k: scrub_deep(v) for k, v in value.items()}
    return value
