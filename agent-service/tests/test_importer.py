"""The Importer: one file in, one proposed Docs page out; the page itself is created only when a person accepts."""

from __future__ import annotations

from .support import collect, error_of, final_of, pdf_base64, run_request


def import_request(**over):
    base = dict(
        kind="import",
        agent={"handle": "importer", "displayName": "Importer", "role": "Importer", "persona": "", "skills": []},
        question='Turn the attached file "vendor-quote.pdf" into a clean Docs page in Markdown.',
        attachments=[{"name": "vendor-quote.pdf", "mime": "application/pdf", "dataBase64": pdf_base64()}],
    )
    base.update(over)
    return run_request(**base)


async def test_a_pdf_becomes_a_proposed_page():
    events = await collect(import_request())
    assert error_of(events) is None
    final = final_of(events)
    assert len(final["cards"]) == 1
    card = final["cards"][0]
    assert card["kind"] == "proposal"
    assert card["items"][0]["type"] == "doc", "the team server looks for the doc item to create the page"
    assert card["items"][0]["title"]
    assert final["text"]


async def test_a_file_that_cannot_be_read_says_so_and_proposes_nothing():
    events = await collect(import_request(question="[fake:empty] Import something."))
    final = final_of(events)
    assert error_of(events) is None
    assert final["cards"] == []
    assert "could not read" in final["text"]
