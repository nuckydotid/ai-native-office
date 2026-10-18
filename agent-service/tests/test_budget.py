"""The per-run token budget: nothing is spent after the cap, and every call is charged."""

from __future__ import annotations

import pytest

from agent_service.errors import BudgetExceeded
from agent_service.models.budget import RunBudget


def test_the_budget_refuses_a_call_once_nothing_is_left():
    budget = RunBudget(max_output_tokens=10, max_call_tokens=4)
    assert budget.before_call() == 4
    budget.charge("m1", 100, 6)
    assert budget.remaining == 4
    assert budget.before_call() == 4
    budget.charge("m1", 10, 4)
    assert budget.remaining == 0
    with pytest.raises(BudgetExceeded):
        budget.before_call()


def test_the_budget_keeps_the_calls_the_tokens_and_the_models():
    budget = RunBudget(max_output_tokens=100, max_call_tokens=50)
    budget.charge("m1", 30, 10)
    budget.charge("m1", 5, 5)
    budget.charge("m2", 1, 1)
    assert budget.calls == 3
    assert budget.input_tokens == 36
    assert budget.output_tokens == 16
    assert budget.models == ["m1", "m2"]
