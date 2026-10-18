from __future__ import annotations

from dataclasses import dataclass, field

from .auth import IdTokenSource
from .config import Settings
from .knowledge.firestore_store import build_store
from .knowledge.service import KnowledgeService
from .models.embeddings import Embedder, build_embedder


@dataclass
class Services:
    """What lives as long as the process: settings, the knowledge index and the token cache."""

    settings: Settings
    knowledge: KnowledgeService
    embedder: Embedder
    tokens: IdTokenSource = field(default_factory=IdTokenSource)


def build_services(settings: Settings) -> Services:
    embedder = build_embedder(settings)
    knowledge = KnowledgeService(build_store(settings), embedder, min_score=settings.retrieval_min_score)
    return Services(settings=settings, knowledge=knowledge, embedder=embedder)
