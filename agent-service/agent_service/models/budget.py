from __future__ import annotations

import time
from dataclasses import dataclass, field

from ..errors import BudgetExceeded


@dataclass
class RunBudget:
    """What one run may spend: output tokens over all its model calls (and per call). Input tokens are only counted."""

    max_output_tokens: int
    max_call_tokens: int = 8192
    input_tokens: int = 0
    output_tokens: int = 0
    calls: int = 0
    models: list[str] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)

    @property
    def remaining(self) -> int:
        return max(0, self.max_output_tokens - self.output_tokens)

    def before_call(self) -> int:
        """The most tokens the next call may ask for. Raises when nothing is left."""
        if self.remaining <= 0:
            raise BudgetExceeded()
        return min(self.max_call_tokens, self.remaining)

    def charge(self, model: str, input_tokens: int, output_tokens: int) -> None:
        self.calls += 1
        self.input_tokens += max(0, input_tokens)
        self.output_tokens += max(0, output_tokens)
        if model and model not in self.models:
            self.models.append(model)

    @property
    def seconds(self) -> float:
        return round(time.monotonic() - self.started, 3)
