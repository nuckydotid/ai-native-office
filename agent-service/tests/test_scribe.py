"""The Scribe: a conversation in, minutes plus proposed tickets out, with action items matched against the board."""

from __future__ import annotations

from .support import collect, error_of, final_of, run_request

STANDUP = [
    {"id": "m1", "name": "Ines", "text": "We decided to ship the sync banner fix on Friday.", "kind": "human"},
    {"id": "m2", "name": "Kai", "text": "Kai will guard the job assignment push behind a flag.", "kind": "human"},
    {"id": "m3", "name": "Zara", "text": "This might slip if the gallery cache is not fixed, that is a risk.", "kind": "human"},
    {"id": "m4", "name": "Owen", "text": "Do we need a release note for the banner?", "kind": "human"},
]
BOARD = [{"key": 13, "title": "Guard job assignment push", "status": "in_progress"}]

MEETING_QUESTION = "Write the minutes of this conversation: the decisions, the action items with owners, the open questions and the risks."


def scribe_request(**over):
    base = dict(
        kind="minutes",
        agent={"handle": "scribe", "displayName": "Scribe", "role": "Minutes", "persona": "", "skills": []},
        question=MEETING_QUESTION,
        history=STANDUP,
        context={"board": BOARD, "docs": []},
    )
    base.update(over)
    return run_request(**base)


async def test_minutes_and_proposed_tickets_come_back_as_one_card():
    events = await collect(scribe_request())
    assert error_of(events) is None
    final = final_of(events)
    assert "Decision" in final["text"]
    assert len(final["cards"]) == 1
    card = final["cards"][0]
    assert card["kind"] == "proposal"
    tickets = [i for i in card["items"] if i["type"] == "ticket"]
    docs = [i for i in card["items"] if i["type"] == "doc"]
    assert tickets, "the action items must be proposed as tickets"
    assert docs and "Meeting minutes" in docs[0]["title"], "the minutes must be proposed as a Docs page"


async def test_an_action_item_that_matches_the_board_points_at_the_ticket():
    events = await collect(scribe_request())
    card = final_of(events)["cards"][0]
    matched = [i for i in card["items"] if i.get("duplicateOf") == 13]
    assert matched, "the job-assignment action item must point at ticket #13 instead of proposing a duplicate"


async def test_a_meeting_with_nothing_in_it_still_returns_minutes():
    events = await collect(scribe_request(history=[]))
    final = final_of(events)
    assert error_of(events) is None
    assert final["cards"]
    card = final["cards"][0]
    assert all(i["type"] == "doc" for i in card["items"])
