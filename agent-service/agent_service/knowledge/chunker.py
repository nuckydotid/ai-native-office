"""Splits a Markdown page into chunks by heading, around 800 tokens each. Ids are deterministic: `<kind>:<id>:<n>`."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .types import Chunk

TARGET_TOKENS = 800
# A token is about four characters of English; good enough to size a chunk without a tokenizer.
CHARS_PER_TOKEN = 4
MAX_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN
MIN_CHARS = 500  # a section thinner than this is joined to its neighbour instead of standing alone

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")


@dataclass
class _Section:
    path: list[str]
    lines: list[str]

    @property
    def text(self) -> str:
        return "\n".join(self.lines).strip()


def _sections(body: str) -> list[_Section]:
    sections: list[_Section] = [_Section([], [])]
    stack: list[tuple[int, str]] = []
    in_fence = False
    for line in body.replace("\r\n", "\n").split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
        m = None if in_fence else _HEADING.match(line)
        if m:
            level, title = len(m.group(1)), m.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            sections.append(_Section([t for _, t in stack], [line]))
        else:
            sections[-1].lines.append(line)
    return [s for s in sections if s.text]


def _split_long(text: str) -> list[str]:
    """A section over the target is cut at paragraph breaks (a paragraph over the target at line breaks, then at spaces)."""
    if len(text) <= MAX_CHARS:
        return [text]
    pieces: list[str] = []
    cur = ""
    for para in re.split(r"\n{2,}", text):
        para = para.strip()
        if not para:
            continue
        while len(para) > MAX_CHARS:
            cut = para.rfind("\n", 0, MAX_CHARS)
            if cut < MAX_CHARS // 2:
                cut = para.rfind(" ", 0, MAX_CHARS)
            if cut < MAX_CHARS // 2:
                cut = MAX_CHARS
            head, para = para[:cut].strip(), para[cut:].strip()
            if cur:
                pieces.append(cur)
                cur = ""
            pieces.append(head)
        if cur and len(cur) + len(para) + 2 > MAX_CHARS:
            pieces.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        pieces.append(cur)
    return pieces


def chunk_markdown(kind: str, item_id: str, title: str, body: str) -> list[Chunk]:
    """Chunks of one doc or ticket. Always at least one (an empty body still has its title, so the item can be found)."""
    sections = _sections(body or "")
    # Join thin sections to the one before them (or after, for the first), so no chunk is a lone heading line.
    merged: list[_Section] = []
    for s in sections:
        if merged and len(merged[-1].text) < MIN_CHARS and len(merged[-1].text) + len(s.text) + 2 <= MAX_CHARS:
            prev = merged[-1]
            merged[-1] = _Section(prev.path or s.path, prev.lines + ["", *s.lines])
        else:
            merged.append(s)
    if len(merged) > 1 and len(merged[-1].text) < MIN_CHARS and len(merged[-2].text) + len(merged[-1].text) + 2 <= MAX_CHARS:
        last = merged.pop()
        merged[-1] = _Section(merged[-1].path, merged[-1].lines + ["", *last.lines])

    chunks: list[Chunk] = []
    for s in merged:
        heading = " › ".join(s.path)
        for piece in _split_long(s.text):
            chunks.append(Chunk(kind, item_id, len(chunks), title, piece, heading))
    if not chunks:
        chunks.append(Chunk(kind, item_id, 0, title, title or item_id, ""))
    return chunks


def embedding_text(chunk: Chunk) -> str:
    """What is embedded: the title and the heading path give a short chunk the context its words lack."""
    head = " | ".join(x for x in (chunk.title, chunk.heading) if x)
    return f"{head}\n\n{chunk.text}" if head else chunk.text
