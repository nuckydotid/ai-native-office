"""A cheap detector for text that tries to give the model orders. It never decides anything: the defence is that such text is
quoted as data. The detector only lets a run say "I ignored instructions inside X" (a step event) and lets the eval count them."""

from __future__ import annotations

import re

_PATTERNS = [
    r"ignore (?:all |any |the |your )?(?:previous|prior|above|earlier|preceding)(?: \w+)? (?:instructions|rules|prompts?|messages?)",
    r"disregard (?:all |any |the |your )?(?:previous|prior|above|earlier)?(?: \w+)? ?(?:instructions|rules|prompts?)",
    r"forget (?:everything|all|your) (?:above|before|instructions|rules)",
    r"(?:reveal|print|show|repeat|output) (?:your |the )?(?:system|hidden|initial) (?:prompt|instructions?)",
    r"you are now (?:a|an|in|the)\b",
    r"new (?:instructions?|rules?|system prompt)\s*:",
    r"\bsystem\s*:\s*you\b",
    r"(?:do not|don't|never) (?:tell|mention|reveal|show) (?:this )?to the user",
    r"(?:reply|respond|answer|say|output) (?:only )?(?:with|exactly)\b",
    r"<\s*/?\s*(?:system|instructions?)\s*>",
    r"override (?:the |all |your )?(?:safety|rules|instructions|policy)",
    r"(?:send|post|email|exfiltrate|leak) (?:the |all |your )?(?:secrets?|passwords?|tokens?|keys?|credentials?)",
]
_RE = re.compile("|".join(f"(?:{p})" for p in _PATTERNS), re.IGNORECASE)


def find_injection(text: str) -> str | None:
    """The phrase that looks like an order to the model, or None."""
    m = _RE.search(text or "")
    return m.group(0) if m else None


def looks_like_injection(text: str) -> bool:
    return find_injection(text) is not None
