"""The Release Agent: the `release_pack` a person approves, and the `rollout_report` that explains a rollout afterwards.

    reader (jobs, scans, rollouts) -> writer (structured output) -> finalize

The readiness scorecard is written from facts: a job passed or it did not, the scan found a severity or it did not, the rollout reached
100% or it did not. The agent narrates; the gate decides.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..contract import ArtifactDraftOut
from ..prompt import artifact_lines_block, jobs_block, quote, ticket_block, user_message
from ..runtime import RunCtx
from ..schemas import ReleaseOut, RolloutOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_pipeline_tools
from .common import Result, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

READ_TASK = """\
Your job in this step is only to READ the facts for this ticket. You do not write the pack.
- Call list_jobs for the ticket, and list_rollouts if the run is about a rollout. Read the log of a failed job with read_job_log.
  At most eight tool calls.
- Finish with a few short bullet notes: which jobs passed on which digest, the scan severity, the rollout steps and their checks."""

RELEASE_TASK = """\
Your job in this step: write the release pack from the facts you were given.
- notes: what a person will notice, at most 6 short lines. Never invent a feature that is not in the accepted change set.
- risk: "low", "medium" or "high", and one sentence why, from the facts (coverage, scan, how much the change touches).
- scorecard: one line per fact, name one of "tests", "coverage", "scan", "changes", "rollback"; ok true only when the job or fact says
  so; detail a few words from the facts.
- summary and message: one or two sentences that introduce the pack."""

ROLLOUT_TASK = """\
Your job in this step: write the rollout report from the checks you were given.
- steps: one line per traffic step, with the percentage, the error rate and the p95 that were measured. Never invent a measurement.
- outcome: "complete", "rolled_back" or "in progress", and one sentence why, from the rollout's state.
- summary: two or three sentences: what was measured, and what it means. message: one or two sentences that introduce the report."""


def build_release(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, pro = rc.llm("main"), rc.llm("pro")
    rollout_run = req.kind == "rollout_review"

    def first() -> str:
        return first_prompt(rc, [ticket_block(req, rc.nonce), artifact_lines_block(req, rc.nonce)])

    def rollout_lines() -> str:
        lines: list[str] = []
        for rollout in rc.scratch.get("rollouts", []):
            lines.append(f"{rollout.get('service')}: state={rollout.get('state')} traffic={rollout.get('trafficPct')}% revision={rollout.get('revision')}")
            for check in rollout.get("checks", []):
                lines.append(f"  step {check.get('percent')}%: errorRate={check.get('errorRate')} p95={check.get('p95Ms')} ok={check.get('ok')}")
        return "\n".join(lines) or "(no rollout yet)"

    def write_prompt() -> str:
        return user_message(
            req,
            rc.nonce,
            blocks=[
                ticket_block(req, rc.nonce),
                artifact_lines_block(req, rc.nonce),
                jobs_block(rc.scratch.get("jobs", []), rc.nonce),
                quote("The rollouts of this ticket", rollout_lines(), rc.nonce),
                quote("Notes from the reader", rc.scratch.get("reader_notes", "(none)"), rc.nonce),
            ],
        )

    reader = Agent(
        name="reader",
        model=main,
        instruction=instruction_of(rc, role="release_reader", task=READ_TASK),
        tools=build_pipeline_tools(rc),
        generate_content_config=gen_config(rc),
        after_model_callback=capture(rc, "reader_notes"),
    )
    writer = Agent(
        name="writer",
        model=pro,
        instruction=instruction_of(rc, role="rollout_writer" if rollout_run else "release_writer", task=ROLLOUT_TASK if rollout_run else RELEASE_TASK),
        output_schema=RolloutOut if rollout_run else ReleaseOut,
        generate_content_config=gen_config(rc, temperature=0.2),
        before_model_callback=feed(rc, write_prompt, "writing"),
    )

    async def finalize_release(ctx: Context, node_input: dict):
        ticket = req.ticket
        if rollout_run:
            out = RolloutOut.model_validate(node_input)
            title = clamp(one_line(out.title, 200), 200) or (f"Rollout report: {ticket.title}" if ticket else "Rollout report")
            message = clamp(one_line(out.message, 600), 600) or "Here is the rollout report."
            steps = [clamp(one_line(s, 240), 240) for s in out.steps if one_line(s, 240)][:8]
            body = "\n".join(
                [
                    "## What was measured",
                    clamp(out.summary, 2000) or "The rollout's checks are listed above.",
                    "",
                    "## Traffic steps",
                    *([f"- {s}" for s in steps] or ["- No step was measured yet."]),
                    "",
                    "## Outcome",
                    clamp(one_line(out.outcome, 400), 400) or "In progress.",
                ]
            )
            artifact = ArtifactDraftOut(kind="rollout_report", title=title, body=body, meta={"outcome": clamp(one_line(out.outcome, 60), 60)})
        else:
            out = ReleaseOut.model_validate(node_input)
            title = clamp(one_line(out.title, 200), 200) or (f"Release pack: {ticket.title}" if ticket else "Release pack")
            message = clamp(one_line(out.message, 600), 600) or "Here is the release pack."
            notes = [clamp(one_line(n, 240), 240) for n in out.notes if one_line(n, 240)][:6]
            scorecard = [(clamp(one_line(s.name, 40), 40), bool(s.ok), clamp(one_line(s.detail, 160), 160)) for s in out.scorecard if one_line(s.name, 40)]
            body = "\n".join(
                [
                    "## Release notes",
                    *([f"- {n}" for n in notes] or ["- No notes written down yet."]),
                    "",
                    "## Risk",
                    clamp(one_line(out.risk, 400), 400) or "Not judged.",
                    "",
                    "## Readiness",
                    *([f"- [{'x' if ok else ' '}] {name}: {detail}" for name, ok, detail in scorecard] or ["- [ ] The facts were not read yet."]),
                    "",
                    "_The gate reads the jobs themselves; this scorecard only says what the agent saw._",
                ]
            )
            artifact = ArtifactDraftOut(kind="release_pack", title=title, body=body, meta={"risk": clamp(one_line(out.risk, 80), 80)})
        rc.scratch["result"] = Result(text=message, artifacts=[artifact])
        yield Event(output={"final": True})

    workflow = Workflow(name="release", edges=[(START, reader, writer, finalize_release)])
    return workflow, first


async def run_release(rc: RunCtx) -> Result:
    workflow, first = build_release(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the release run ended without an artifact")
    return result
