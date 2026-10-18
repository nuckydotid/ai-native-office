"""Text cleaning shared by every path: what comes in from people and documents, and what goes out to a room."""

from __future__ import annotations

import re

# Mirrors `sanitizeText` in src/shared/workspace/text.ts: control characters (but not tab, line feed, carriage return), the
# line and paragraph separators, and the invisible ones that flip or hide text (zero-width space, bidi marks and overrides,
# the byte-order mark and the "tag" characters that can smuggle a whole sentence past a reader).
_UNWANTED: tuple[tuple[int, int], ...] = (
    (0x00, 0x08),
    (0x0B, 0x0C),
    (0x0E, 0x1F),
    (0x7F, 0x7F),
    (0x061C, 0x061C),
    (0x180E, 0x180E),
    (0x200B, 0x200B),
    (0x200E, 0x200F),
    (0x2028, 0x2029),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x2069),
    (0xFEFF, 0xFEFF),
    (0xE0000, 0xE007F),
)

_UNWANTED_RE = re.compile(
    "[" + "".join(f"\\U{lo:08x}-\\U{hi:08x}" for lo, hi in _UNWANTED) + "\ud800-\udfff]"
)


def clamp(text: str, max_chars: int) -> str:
    """At most `max_chars` code points (Python strings are already code points)."""
    return text if len(text) <= max_chars else text[:max_chars]


def sanitize_text(text: str, max_chars: int) -> str:
    return clamp(_UNWANTED_RE.sub("", text).strip(), max_chars)


def one_line(text: str, max_chars: int) -> str:
    return clamp(re.sub(r"\s+", " ", text).strip(), max_chars)


def clip_at_sentence(text: str, max_chars: int) -> str:
    """Shortens at a sentence or line end when it can, so a cut never lands mid-word."""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    for sep in ("\n\n", "\n", ". ", "! ", "? "):
        i = cut.rfind(sep)
        if i >= max_chars * 0.5:
            return cut[: i + (0 if sep.startswith("\n") else 1)].rstrip()
    i = cut.rfind(" ")
    return (cut[:i] if i >= max_chars * 0.5 else cut).rstrip()
