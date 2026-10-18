"""Turns verified claims into the chat message and its citations, and carries the refusal."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .contract import CITATIONS_MAX, QUOTE_MAX, Citation
from .knowledge.types import Passage
from .models.embeddings import tokens
from .runtime import Evidence
from .schemas import Claim
from .textutil import clamp, one_line

REFUSAL = "I could not find this in the team's knowledge."


def refusal_text(searched: int = 0, missing: str = "") -> str:
    extra = ""
    if missing.strip():
        extra = f" Nothing I read covers {one_line(missing, 120).rstrip('.')}."
    elif searched:
        extra = f" I looked through {searched} passage{'s' if searched != 1 else ''} from the Docs and tickets and none of them answers it."
    return f"{REFUSAL}{extra} If it is written down somewhere, point me to the page and I will read it."


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def quote_in(passage_text: str, quote: str) -> bool:
    """Whether a quote really is in the passage (case and spacing aside). Models paraphrase; a citation must not."""
    q = _norm(quote).strip(" .\"'“”")
    return len(q) >= 8 and q in _norm(passage_text)


def best_sentence(passage_text: str, claim: str) -> str:
    """The sentence of a passage that shares the most words with a claim: an honest quote when the model's own does not check out."""
    want = set(tokens(claim))
    best, best_score = "", 0.0
    for raw in re.split(r"(?<=[.!?])\s+|\n+", passage_text):
        s = raw.strip(" -*#>\t")
        if len(s) < 12:
            continue
        got = set(tokens(s))
        score = len(want & got) / (len(want) or 1)
        if score > best_score:
            best, best_score = s, score
    return best


def support_ratio(claim: str, passages: list[Passage]) -> float:
    """The share of a claim's content words found in the passages it cites: a cheap, deterministic floor under the verifier."""
    want = set(tokens(claim))
    if not want:
        return 1.0
    have: set[str] = set()
    for p in passages:
        have |= set(tokens(p.text)) | set(tokens(p.title))
    return len(want & have) / len(want)


@dataclass
class Grounded:
    text: str
    citations: list[Citation] = field(default_factory=list)


def compose(claims: list[Claim], evidence: Evidence, *, removed: int = 0) -> Grounded:
    """The answer as short paragraphs with [n] markers, a Sources line, and a citation per cited document or ticket."""
    order: list[tuple[str, str]] = []  # (kind, item id) in order of first use
    info: dict[tuple[str, str], tuple[Passage, str]] = {}  # -> (first passage, quote)
    lines: list[str] = []
    for c in claims:
        marks: list[int] = []
        for label in c.evidence:
            p = evidence.get(label)
            if p is None:
                continue
            key = (p.kind, p.item_id)
            if key not in info:
                if len(order) >= CITATIONS_MAX:
                    continue
                q = c.quote if c.quote and quote_in(p.text, c.quote) else best_sentence(p.text, c.text)
                info[key] = (p, clamp(one_line(q, QUOTE_MAX), QUOTE_MAX))
                order.append(key)
            n = order.index(key) + 1
            if n not in marks:
                marks.append(n)
        lines.append(f"{c.text.strip()} {''.join(f'[{n}]' for n in sorted(marks))}".rstrip())
    citations = [
        Citation(kind=info[k][0].kind, id=info[k][0].item_id, title=info[k][0].title, quote=info[k][1] or None)  # type: ignore[arg-type]
        for k in order
    ]
    body = "\n\n".join(lines)
    if citations:
        body += "\n\nSources: " + " · ".join(f"[{i + 1}] {one_line(c.title, 80)}" for i, c in enumerate(citations))
    if removed:
        body += f"\n\n_I left out {removed} statement{'s' if removed != 1 else ''} I could not confirm in the sources._"
    return Grounded(body, citations)
