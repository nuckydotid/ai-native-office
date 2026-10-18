"""The Reviewer: a ticket's notes against its acceptance criteria, with a person deciding what to do about it."""

from __future__ import annotations

from .support import collect, error_of, final_of, run_request

TICKET = {
    "key": 4,
    "title": "Photo attachments crash on small screens",
    "status": "review",
    "body": (
        "## Acceptance criteria\n"
        "1. The gallery opens on screens narrower than 360 px.\n"
        "2. A photo can be attached from the camera roll.\n"
        "## Notes\n"
        "The small screen fix shipped: the gallery opens on screens narrower than 360 px."
    ),
}


class StubWeb:
    """Stands in for the team server's /internal/v1 reads."""

    def __init__(self, ticket: dict | None):
        self._ticket = ticket

    async def ticket(self, key):
        return self._ticket

    async def tickets(self, status: str = "", q: str = ""):
        return []

    async def page(self, page_id):
        return None

    async def messages(self, room: str = "", session: str = "", limit: int = 40):
        return []


def review_request(**over):
    base = dict(
        kind="review",
        agent={"handle": "reviewer", "displayName": "Reviewer", "role": "Reviewer", "persona": "", "skills": []},
        question="@reviewer check ticket #4 against its acceptance criteria",
    )
    base.update(over)
    return run_request(**base)


async def test_criteria_are_checked_against_the_notes():
    events = await collect(review_request(), web=StubWeb(TICKET))
    assert error_of(events) is None
    final = final_of(events)
    assert "Review of #4" in final["text"]
    assert "changes" in final["text"]
    assert "gallery opens on screens narrower than 360 px" in final["text"], "a met criterion must say so"
    assert "camera roll" in final["text"], "a missing criterion must be named"


async def test_a_ticket_with_nothing_read_still_answers_plainly():
    events = await collect(review_request(), web=StubWeb(None))
    final = final_of(events)
    assert error_of(events) is None
    assert "Review of #4" in final["text"]
    assert "person decides" in final["text"]
