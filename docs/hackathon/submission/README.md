# The submission deck

The cup asks for its own PowerPoint template, filled in. `template.pptx` is that file, unchanged. `../submission.pptx` is the
filled copy (the template's own slides, header, footer and closing slide) and `../submission.pdf` is the same slides as a PDF.

The slides follow the template's order: Team Details, Brief about the idea, Opportunities, List of features, Process flow or
Use-case diagram, Wireframes, Architecture diagram, Technologies, Estimated implementation cost, Snapshots of the prototype
(two slides), Prototype performance report, Additional details and future development, Links, Thank you. The template's note to
participants and its spare blank slide are left out.

## What is real

- **Snapshots** (`shots/`) are screenshots of the live demo, taken with headless Chromium (Playwright) while the agents answered and
  Cloud Build ran for real. The tall ones are crops of the stage panel.
- **Numbers** on the performance slide: the knowledge ones come from `eval-summary.json`, written from one run of
  `agent-service/eval` (38 cases, `gemini-3.8-flash`, 2026-10-17; the one failing case is named on the slide). The pipeline ones are
  in `pipeline-run.json`: ranges over repeated runs of the same ticket flow on the deployed demo, 18 to 19 October 2026.
- **Diagrams** (flow, wireframe, architecture) are native PowerPoint shapes, so they can be edited in PowerPoint or Google Slides.

## Rebuild

```bash
python3 docs/hackathon/submission/build.py --team "Worktrees Studio" --leader "Nucky Ridwan Gunawan" --video-url "https://..."
```

Standard library only. It writes `submission.pptx` and `submission.pdf` next to this folder, and prints any text box that
overflows. `--screens` also writes one PNG per slide into `build/` (ignored by Git) for a visual check. The PDF step needs Google
Chrome (`CHROME=/path/to/chrome` elsewhere than macOS).

`engine.py` describes each slide once and writes it twice: as PowerPoint XML into the template's own slide parts, and as HTML that
Chrome prints to PDF. `deck.py` holds the content. The template names the font Google Sans Flex; PowerPoint and Google Slides
substitute it if it is not installed, and the PDF is drawn in Arial.
