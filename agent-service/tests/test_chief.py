"""Studio, the chief of staff: one request, handed to the colleague whose job it is, or answered from the roster."""

from __future__ import annotations

from .support import collect, error_of, final_of, index_page, make_services, run_request, steps_of


def studio_request(question: str, **over):
    base = dict(
        agent={"handle": "studio", "displayName": "Studio", "role": "Chief of staff", "persona": "", "skills": []},
        question=question,
    )
    base.update(over)
    return run_request(**base)


async def test_a_question_about_the_records_goes_to_the_librarian():
    services = make_services()
    await index_page(services, "hours", "Remote work", "Core hours are 10:00 to 14:00 Singapore time.")
    events = await collect(studio_request("What are our core working hours?"), services)
    assert error_of(events) is None
    final = final_of(events)
    assert "10:00" in final["text"]
    assert final["citations"]
    routed = [s for s in steps_of(events) if s["tool"] == "route"]
    assert routed and "librarian" in routed[0]["summary"]


async def test_a_greeting_is_answered_from_the_roster_without_another_answer():
    events = await collect(studio_request("Hi team"))
    final = final_of(events)
    assert "@librarian" in final["text"]
    assert final["cards"] == []


async def test_a_goal_goes_to_the_planner_and_comes_back_as_a_plan_card():
    events = await collect(studio_request("How should we plan the PDF export work?"))
    final = final_of(events)
    assert final["cards"] and final["cards"][0]["kind"] == "plan"
    assert final["cards"][0]["plan"]["steps"], "a plan card must carry its steps"
