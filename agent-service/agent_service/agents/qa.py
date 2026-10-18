"""The QA Agent: reads the jobs that ran for a ticket and writes the `test_report` a person reads at the Test gate.

    reader (jobs, logs, the accepted change set) -> reporter (structured output) -> finalize

The report never invents a result: every number comes from a job the pipeline ran. If the model proposes new end-to-end tests, they are
merged with the accepted change set into a new `change_set` draft, so a person can accept both together.
"""

from __future__ import annotations

from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..contract import ArtifactDraftOut, ArtifactFile
from ..pipeline import deny_scan, files_from_model, normalize_files, parse_change_set
from ..prompt import artifact_lines_block, jobs_block, quote, ticket_block, user_message
from ..runtime import RunCtx
from ..schemas import TestReportOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_pipeline_tools
from .common import Result, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

READ_TASK = """\
Your job in this step is only to READ the facts about this ticket's tests. You do not write the report.
- Call list_jobs for the ticket. Read the log of any job that failed with read_job_log, and read the accepted change set with
  read_artifact if the context lists one. At most eight tool calls.
- Finish with a few short bullet notes: which jobs ran and on which digest, what passed, what failed and why, what the coverage was."""

REPORT_TASK = """\
Your job in this step: write the test report from the facts you were given.
- Every number must come from a job: never invent a pass count, a coverage or a duration. If a job did not run, say so.
- passed and failed: the totals from the unit and end-to-end jobs on the accepted change set. coverage_pct: the line coverage the unit
  job reported (0 when none did).
- regression: at most 6 lines naming the existing areas this change could break, based on which files it touched.
- e2e_files: leave empty. Only if the ticket truly has no end-to-end coverage and the report would be incomplete without it, add whole
  end-to-end test files (same rules as a change set: only sample-app/e2e/**, a baseSha of null for a new file).
- summary: two or three sentences for the person reading the Test stage. message: one or two sentences that introduce the report."""


def build_qa(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, pro = rc.llm("main"), rc.llm("pro")

    def first() -> str:
        return first_prompt(rc, [ticket_block(req, rc.nonce), artifact_lines_block(req, rc.nonce)])

    def report_prompt() -> str:
        return user_message(
            req,
            rc.nonce,
            blocks=[
                ticket_block(req, rc.nonce),
                artifact_lines_block(req, rc.nonce),
                jobs_block(rc.scratch.get("jobs", []), rc.nonce),
                quote("Notes from the reader", rc.scratch.get("reader_notes", "(none)"), rc.nonce),
            ],
        )

    reader = Agent(
        name="reader",
        model=main,
        instruction=instruction_of(rc, role="test_reader", task=READ_TASK),
        tools=build_pipeline_tools(rc),
        generate_content_config=gen_config(rc),
        after_model_callback=capture(rc, "reader_notes"),
    )
    reporter = Agent(
        name="reporter",
        model=pro,
        instruction=instruction_of(rc, role="qa", task=REPORT_TASK),
        output_schema=TestReportOut,
        generate_content_config=gen_config(rc, temperature=0.2),
        before_model_callback=feed(rc, report_prompt, "writing"),
    )

    async def finalize_report(ctx: Context, node_input: dict):
        out = TestReportOut.model_validate(node_input)
        ticket = req.ticket
        title = clamp(one_line(out.title, 200), 200) or (f"Test report: {ticket.title}" if ticket else "Test report")
        message = clamp(one_line(out.message, 600), 600) or "Here is the test report."
        coverage = max(0.0, min(100.0, float(out.coverage_pct or 0)))
        passed = max(0, int(out.passed or 0))
        failed = max(0, int(out.failed or 0))
        regression = [clamp(one_line(r, 200), 200) for r in out.regression if one_line(r, 200)][:6]
        body = "\n".join(
            [
                "## Results",
                f"- Passed: {passed}",
                f"- Failed: {failed}",
                f"- Line coverage: {coverage:g}%",
                "",
                "## Summary",
                clamp(out.summary, 2000) or "The jobs that ran are listed above; nothing else was measured.",
                "",
                "## Regression",
                *([f"- {r}" for r in regression] or ["- Nothing else was identified as at risk."]),
                "",
                "_Every number comes from a job the pipeline ran._",
            ]
        )
        artifacts = [ArtifactDraftOut(kind="test_report", title=title, body=body, meta={"passed": passed, "failed": failed, "coveragePct": coverage})]

        # New end-to-end tests, if any, are merged with the accepted change set into a new draft a person can accept.
        accepted = next((a for a in rc.scratch.get("artifacts", {}).values() if a.get("kind") == "change_set"), None)
        proposed = files_from_model(out.e2e_files)
        if accepted is not None and proposed:
            merged = {str(f.get("path")): f for f in (accepted.get("files") or [])}
            for file in proposed:
                merged[str(file.get("path"))] = file
            files = parse_change_set(normalize_files(list(merged.values()), rc.scratch.get("repo_list")))
            if files and not deny_scan(files):
                artifacts.append(
                    ArtifactDraftOut(
                        kind="change_set",
                        title=f"Change set with end-to-end tests: {title}"[:200],
                        body="The accepted change set plus the end-to-end tests the QA Agent added. Accepting this replaces the change set the pipeline runs on.",
                        files=[ArtifactFile(**f) for f in files],
                    )
                )
                message += "\n\nI also drafted a change set with the new end-to-end tests."
        rc.scratch["result"] = Result(text=message, artifacts=artifacts)
        yield Event(output={"final": True})

    workflow = Workflow(name="qa", edges=[(START, reader, reporter, finalize_report)])
    return workflow, first


async def run_qa(rc: RunCtx) -> Result:
    workflow, first = build_qa(rc)
    await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the QA run ended without a report")
    return result
