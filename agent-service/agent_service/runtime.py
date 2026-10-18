"""Everything one run shares: the request, the nonce, the budget, what has been read (evidence), the models and the event sink."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from google.adk.models.base_llm import BaseLlm

from .config import Settings
from .contract import Phase, RunRequest
from .injection import find_injection
from .knowledge.service import KnowledgeService
from .knowledge.types import Passage
from .models.budget import RunBudget
from .models.embeddings import Embedder
from .models.resilient import ResilientLlm
from .prompt import new_nonce
from .tools.web import WebClient

log = logging.getLogger("agent_service.run")

Emit = Callable[[str, dict[str, Any]], None]


class Evidence:
    """The passages a run has read, each under a short label (P1, P2...) that the model cites and the verifier checks."""

    def __init__(self) -> None:
        self._labels: dict[str, str] = {}
        self._items: dict[str, Passage] = {}

    def add(self, p: Passage) -> str:
        key = p.key
        if key not in self._labels:
            self._labels[key] = f"P{len(self._labels) + 1}"
            self._items[self._labels[key]] = p
        return self._labels[key]

    def get(self, label: str) -> Passage | None:
        return self._items.get(label.strip().upper())

    def all(self) -> list[tuple[str, Passage]]:
        return list(self._items.items())

    def __len__(self) -> int:
        return len(self._items)


@dataclass
class RunCtx:
    req: RunRequest
    settings: Settings
    knowledge: KnowledgeService
    embedder: Embedder
    budget: RunBudget
    emit: Emit
    web: WebClient | None = None
    nonce: str = field(default_factory=new_nonce)
    evidence: Evidence = field(default_factory=Evidence)
    # Pipelines keep what they hand between steps here (drafts, verdicts, what was removed).
    scratch: dict[str, Any] = field(default_factory=dict)
    # Builds the model for a tier. Tests swap it to inject a flaky or scripted one.
    model_builder: Callable[[RunCtx, str], list[BaseLlm]] | None = None
    _llms: dict[str, ResilientLlm] = field(default_factory=dict)
    _guarded: set[str] = field(default_factory=set)
    _last_phase: str = ""

    # ── events ──
    def status(self, phase: Phase) -> None:
        if phase != self._last_phase:
            self._last_phase = phase
            self.emit("status", {"phase": phase})

    def step(self, tool: str, summary: str) -> None:
        self.emit("step", {"tool": tool, "summary": summary[:160]})

    # ── models ──
    def llm(self, tier: str = "main") -> ResilientLlm:
        """`main` (answers and tools), `fast` (verifier, router) or `pro` (planner, importer): one wrapper per tier per run."""
        if tier not in self._llms:
            from .models.factory import build_chain

            chain = (self.model_builder or build_chain)(self, tier)
            self._llms[tier] = ResilientLlm(
                chain=chain,
                budget=self.budget,
                attempts=self.settings.retry_attempts,
                base_delay=self.settings.retry_base_seconds,
            )
        return self._llms[tier]

    @property
    def model_used(self) -> str:
        for tier in ("main", "pro", "fast"):
            llm = self._llms.get(tier)
            if llm and llm.last_model:
                return llm.last_model
        return self.budget.models[-1] if self.budget.models else self.settings.model

    # ── evidence ──
    def add_passages(self, passages: list[Passage]) -> list[str]:
        """Registers passages, and says once for each one that holds text which tries to give orders (it stays data)."""
        labels = []
        for p in passages:
            labels.append(self.evidence.add(p))
            if p.key not in self._guarded and (hit := find_injection(p.text)):
                self._guarded.add(p.key)
                log.info("instruction-like text inside %s was treated as data", p.key)
                self.step("guard", f"Ignored instructions inside “{p.title[:60]}” and treated them as data")
        return labels
