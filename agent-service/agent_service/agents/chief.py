"""Studio, the chief of staff: reads one request and hands it to the colleague whose job it is.

    router (fast model, structured Route) -> librarian | planner | scribe | reviewer | self

The route is a decision about ONE question, taken with no tools; every other agent keeps its own pipeline unchanged. "self" is
answered from the roster without another model call, so a greeting never spends a run's budget on nothing.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..prompt import history_block, user_message
from ..runtime import RunCtx
from ..schemas import Route
from .common import Result, feed, first_prompt, gen_config, instruction_of, run_workflow

ROUTE_TASK = """\
Your job in this step: read what the person asked in the team chat and choose who should answer it.
- "librarian": a question about what the team has written down — docs, tickets, past decisions, policies, numbers.
- "planner": a goal to turn into a plan ("how should we do X", "plan X", "what would it take to X").
- "scribe": writing up a meeting — minutes, decisions, action items.
- "reviewer": checking a ticket's notes against its acceptance criteria, before review.
- "designer": designing a screen or a flow for a ticket.
- "developer": implementing a ticket as a change set of code and its tests.
- "qa": the tests for a ticket: what passed, what failed, what could regress.
- "release": preparing a release, or writing up a rollout.
- "self": a greeting, a question about the studio itself, or anything you can answer in one line without reading the team's records.
- question: when handing over, rewrite the request for that colleague in one plain sentence that keeps every name, number and ticket
  reference exactly; leave it empty to pass the words on unchanged. reason: a few words. Answer with the route only."""


def _self_text(rc: RunCtx, route: Route | None) -> str:
    reason = f" ({route.reason.strip()})" if route and route.reason.strip() else ""
    return (
        f"I kept this one{reason}. Here is who does what in this office:\n"
        "- @librarian answers from the team's Docs, tickets and past meetings, with citations.\n"
        "- @planner (the Planner Agent) turns a goal into a plan card, starting from what the team already knows.\n"
        "- @scribe writes a meeting's minutes and proposes the tickets.\n"
        "- @reviewer checks a ticket's notes against its acceptance criteria.\n"
        "- @designer draws a screen or a flow for a ticket.\n"
        "- @developer writes a change set of code and its unit tests.\n"
        "- @qa reports what the tests say and what could regress.\n"
        "- @release prepares a release pack or a rollout report.\n"
        "Mention one of them with your question, or ask me a question about the team's records and I will hand it to the right colleague."
    )


def build_chief(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    fast = rc.llm("fast")

    def first() -> str:
        return first_prompt(rc, [history_block(req.history, rc.nonce)])

    router = Agent(
        name="router",
        model=fast,
        instruction=instruction_of(rc, role="router", task=ROUTE_TASK),
        output_schema=Route,
        generate_content_config=gen_config(rc, temperature=0.0),
        before_model_callback=feed(rc, first, "thinking"),
    )

    async def keep_route(ctx: Context, node_input: dict):
        route = Route.model_validate(node_input)
        target = route.target.strip().lower()
        # A word the schema did not expect never ends the run: anything unknown goes to the Librarian, which answers or refuses.
        route.target = target if target in ("librarian", "planner", "scribe", "reviewer", "designer", "developer", "qa", "release", "self") else "librarian"
        rc.scratch["route"] = route
        rc.step("route", f"Sent the question to @{route.target}" + (f" — {route.reason.strip()[:80]}" if route.reason.strip() else ""))
        yield Event(output={"target": route.target})

    return Workflow(name="chief", edges=[(START, router, keep_route)]), first


async def run_chief(rc: RunCtx) -> Result:
    workflow, first = build_chief(rc)
    await run_workflow(rc, workflow, first())
    route: Route | None = rc.scratch.get("route")
    target = route.target if route else "self"
    if target == "self":
        return Result(text=_self_text(rc, route))
    if route and route.question.strip():
        rc.req = rc.req.model_copy(update={"question": route.question.strip()})
    if target == "planner":
        from .planner import run_planner

        return await run_planner(rc)
    if target == "scribe":
        from .scribe import run_scribe

        return await run_scribe(rc)
    if target == "reviewer":
        from .reviewer import run_reviewer

        return await run_reviewer(rc)
    if target == "designer":
        from .designer import run_designer

        return await run_designer(rc)
    if target == "developer":
        from .developer import run_developer

        return await run_developer(rc)
    if target == "qa":
        from .qa import run_qa

        return await run_qa(rc)
    if target == "release":
        from .release import run_release

        return await run_release(rc)
    from .librarian import run_librarian

    return await run_librarian(rc)
