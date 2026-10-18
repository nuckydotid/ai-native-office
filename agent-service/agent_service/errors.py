from __future__ import annotations

from .contract import ErrorCode


class RunError(Exception):
    """An ending the run reports to the team server as an `error` event, with a code the server maps to a friendly line."""

    code: ErrorCode = "internal"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.default_message)

    default_message = "The AI service hit an unexpected problem."


class BudgetExceeded(RunError):
    code = "budget"
    default_message = "This run used its whole output-token budget."


class ModelUnavailable(RunError):
    code = "model_unavailable"
    default_message = "The AI model is not available right now. Please try again in a moment."


class RunTimeout(RunError):
    code = "model_unavailable"
    default_message = "The AI took too long to answer and was stopped."


class InvalidRun(RunError):
    code = "invalid"
    default_message = "This request is not one the AI service can run."
