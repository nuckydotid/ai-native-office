"""The Developer Agent: turns a ticket, its spec and its design into a `change_set`.

    reader (repo and artifacts, read-only tools) -> drafter (structured output) -> check (pure) -> repairer (once) -> finalize

A change set is whole files, not a diff: the pipeline lays them over the sample app's trunk, runs the real build and the real tests, and
a person accepts exactly that digest. Everything the model writes is validated twice: here with the same rules as the team server, and
again when the team server keeps the draft.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from google.adk import Agent, Context, Event, Workflow
from google.adk.workflow import START

from ..contract import ArtifactDraftOut, ArtifactFile
from ..pipeline import FILES_MAX, FILE_LINES_MAX, deny_scan, files_from_model, normalize_files, parse_change_set
from ..prompt import artifact_lines_block, file_contents_block, jobs_block, quote, repo_block, ticket_block, user_message
from ..runtime import RunCtx
from ..schemas import ChangeSetOut
from ..textutil import clamp, one_line
from ..tools.toolset import build_pipeline_tools
from .common import Result, capture, feed, first_prompt, gen_config, instruction_of, run_workflow

log = logging.getLogger(__name__)

READER_TASK = """\
Your job in this step is only to READ, so the drafter has the real code in front of it. You do not write the change set.
- Call list_repo once. Then read every file the change will touch with read_repo_file, and read the accepted spec and design with
  read_artifact if the run's context lists them. Also read the end-to-end spec in `sample-app/e2e/` that covers the screen you change.
  At most ten tool calls.
- If this ticket already has a change set whose build or tests FAILED (call list_jobs with the ticket id), read that job's log with
  read_job_log and say in your notes exactly what failed. A new draft must fix that, not repeat it.
- Finish with a few short bullet notes: which files the change touches, what they do now, and which unit test file belongs with them."""

DRAFT_TASK = f"""\
Your job in this step: write the change set for this ticket, as whole files.
- Only these places: `sample-app/src/**`, `sample-app/tests/**`, `sample-app/e2e/**`. Never the server, the Dockerfile, the lockfile,
  the CI scripts or any config.
- Each file is its path, its `op` and its text as `lines`: one array item per line, no line endings, no runs of blank lines. A `delete`
  has no lines. You do not write the role or any hash: the pipeline sets those. At most {FILES_MAX} files and {FILE_LINES_MAX} lines each.
- The existing end-to-end specs are a contract: they find things by their labels, roles and names. Keep every one of those working, or
  change the spec in the same change set so it matches. A prototype's look is a suggestion; the names the tests use are not.
- Every file you write must be complete: finish it with its last closing brace, tag and export. A truncated file fails the build.
- Prefer editing a few small files in full over many. A file you rewrite must keep everything the ticket does not change.
- Never rewrite a long file for a small change. In particular leave `sample-app/src/styles.css` alone: put new styles in a new small
  file next to the component (for example `sample-app/src/components/StatusFilter.css`) and import it from the component.
- What the sample app has, and nothing else: React 19, Vite and TypeScript; unit tests with vitest in a Node environment, in
  `sample-app/tests/*.test.ts` (never .tsx), and only for pure code in `sample-app/src/api/`; end-to-end tests with Playwright in
  `sample-app/e2e/*.spec.ts`. There is no DOM or React testing library and you cannot add a dependency: the package.json is ours.
  So put the logic a unit test needs into `src/api` and keep components thin.
- Write the source change and its unit test together. The unit test must import from the source file and pass with vitest; the code must
  typecheck. Keep the change as small as the ticket allows.
- The prototype in the design is a picture, not code to copy: implement the behaviour, not the pixels.
- Forbidden, and a person will see the refusal: child_process, node network or file modules, fetch to an absolute URL, WebSocket, eval,
  dynamic import(), process.env, password fields, external links, dangerouslySetInnerHTML, document.cookie.
- body: a short note on what changed and why. message: one or two sentences that introduce the draft."""

REPAIR_TASK = """\
Your job in this step: fix the change set you were given, using the exact problems listed. Change nothing else.
- If the problems list says the change set is valid, repeat it unchanged.
- Keep the same rules: the three writable roots, whole files, a correct `baseSha`, at most 8 files and 400 lines each, source and its
  unit test together."""


def _files_of(out: ChangeSetOut, repo: list[dict] | None) -> list[dict] | None:
    return parse_change_set(normalize_files(files_from_model(out.files), repo))


def _problems_of(candidate: dict, repo: list[dict] | None = None) -> list[str]:
    try:
        out = ChangeSetOut.model_validate(candidate)
    except Exception:  # noqa: BLE001 - a malformed candidate is just not usable
        return ["the change set could not be read"]
    problems: list[str] = []
    if not one_line(out.title, 200):
        problems.append("the change set needs a title")
    if not one_line(out.body, 800):
        problems.append("the change set needs a short body")
    files = _files_of(out, repo)
    if files is None:
        problems.append("the files are outside sample-app/src, tests or e2e, or over a limit")
    else:
        findings = deny_scan(files)
        if findings:
            first = findings[0]
            problems.append(f"a change set cannot use {first['rule']} ({first['path']}, line {first['line']})")
    return problems


def build_developer(rc: RunCtx) -> tuple[Workflow, Callable[[], str]]:
    req = rc.req
    main, pro = rc.llm("main"), rc.llm("pro")

    def first() -> str:
        return first_prompt(rc, [ticket_block(req, rc.nonce), artifact_lines_block(req, rc.nonce)])

    def draft_prompt() -> str:
        artifacts = rc.scratch.get("artifacts", {})
        bodies = {
            f"{artifact.get('kind', 'artifact')} “{artifact.get('title', '')}”": str(artifact.get("body", ""))
            for artifact in artifacts.values()
            if artifact.get("body")
        }
        return user_message(
            req,
            rc.nonce,
            blocks=[
                ticket_block(req, rc.nonce),
                artifact_lines_block(req, rc.nonce),
                repo_block(rc.scratch.get("repo_list", []), rc.nonce),
                file_contents_block(rc.scratch.get("repo_files", {}), rc.nonce),
                file_contents_block(bodies, rc.nonce),
                jobs_block(rc.scratch.get("jobs", []), rc.nonce),
                quote("Notes from the reader", rc.scratch.get("reader_notes", "(none)"), rc.nonce),
                *([quote("The log of a job that failed on the last change set", "\n\n".join(str(t)[-3000:] for t in rc.scratch["job_logs"].values()), rc.nonce)] if rc.scratch.get("job_logs") else []),
                *([quote("Note from the pipeline", rc.scratch["retry_note"], rc.nonce)] if rc.scratch.get("retry_note") else []),
            ],
        )

    def repair_prompt() -> str:
        draft = rc.scratch.get("draft", {})
        problems = rc.scratch.get("problems", [])
        return user_message(
            req,
            rc.nonce,
            blocks=[
                quote("The change set you wrote", str(draft), rc.nonce),
                quote("Problems to fix", "\n".join(f"- {p}" for p in problems) or "(none: repeat the change set unchanged)", rc.nonce),
                repo_block(rc.scratch.get("repo_list", []), rc.nonce),
            ],
        )

    reader = Agent(
        name="reader",
        model=main,
        instruction=instruction_of(rc, role="repo_reader", task=READER_TASK),
        tools=build_pipeline_tools(rc),
        generate_content_config=gen_config(rc),
        after_model_callback=capture(rc, "reader_notes"),
    )
    drafter = Agent(
        name="drafter",
        model=pro,
        instruction=instruction_of(rc, role="drafter", task=DRAFT_TASK),
        output_schema=ChangeSetOut,
        generate_content_config=gen_config(rc, temperature=0.2),
        before_model_callback=feed(rc, draft_prompt, "writing"),
    )
    repairer = Agent(
        name="repairer",
        model=pro,
        instruction=instruction_of(rc, role="repairer", task=REPAIR_TASK),
        output_schema=ChangeSetOut,
        generate_content_config=gen_config(rc, temperature=0.1),
        before_model_callback=feed(rc, repair_prompt, "writing"),
    )

    async def check(ctx: Context, node_input: dict):
        rc.scratch["draft"] = node_input
        rc.scratch["problems"] = _problems_of(node_input, rc.scratch.get("repo_list"))
        if rc.scratch["problems"]:
            rc.step("validate", f"The draft needs one repair: {rc.scratch['problems'][0]}")
        else:
            rc.step("validate", "The draft is valid")
        yield Event(output={"problems": rc.scratch["problems"]})

    async def finalize_change(ctx: Context, node_input: dict):
        candidates = [node_input, rc.scratch.get("draft", {})]
        chosen: ChangeSetOut | None = None
        problems: list[str] = []
        for candidate in candidates:
            try:
                out = ChangeSetOut.model_validate(candidate)
            except Exception:  # noqa: BLE001 - a malformed candidate is just not usable
                continue
            why = _problems_of(candidate, rc.scratch.get("repo_list"))
            if not why:
                chosen = out
                break
            problems = why
        if chosen is None:
            message = "I could not write a change set that the pipeline would accept. " + "; ".join(problems[:2])
            rc.scratch["result"] = Result(text=message)
            yield Event(output={"final": True})
            return
        files = _files_of(chosen, rc.scratch.get("repo_list")) or []
        title = clamp(one_line(chosen.title, 200), 200) or (f"Change set: {req.ticket.title}" if req.ticket else "Change set")
        body = clamp(one_line(chosen.body, 800), 800) or "A change to the portal."
        message = clamp(one_line(chosen.message, 600), 600) or "Here is the change set."
        message += f"\n\n{len(files)} file{'s' if len(files) != 1 else ''}: " + ", ".join(str(f["path"]).split("/")[-1] for f in files[:6])
        artifact = ArtifactDraftOut(kind="change_set", title=title, body=body, files=[ArtifactFile(**f) for f in files])
        rc.scratch["result"] = Result(text=message, artifacts=[artifact])
        yield Event(output={"final": True})

    workflow = Workflow(name="developer", edges=[(START, reader, drafter, check, repairer, finalize_change)])
    return workflow, first


async def run_developer(rc: RunCtx) -> Result:
    try:
        workflow, first = build_developer(rc)
        await run_workflow(rc, workflow, first())
    except Exception as exc:  # noqa: BLE001 - a model that ran away or answered with broken JSON gets one more go, told to keep it small
        log.warning("developer run failed once (%s); trying again", type(exc).__name__)
        rc.step("retry", "The draft did not come out whole; trying once more with a smaller change")
        rc.scratch["retry_note"] = "Your last attempt did not come out as valid output. Change as little as the ticket allows: at most three files, short ones."
        rc.scratch.pop("result", None)
        workflow, first = build_developer(rc)
        await run_workflow(rc, workflow, first())
    result = rc.scratch.get("result")
    if result is None:
        raise RuntimeError("the developer run ended without a change set")
    return result
