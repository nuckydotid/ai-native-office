#!/usr/bin/env python3
"""Builds the cup's submission: a filled copy of its PowerPoint template, and the same slides as a PDF.

  python3 docs/hackathon/submission/build.py [--team NAME] [--leader NAME] [--video-url URL] [--no-pdf]

Writes docs/hackathon/submission.pptx and docs/hackathon/submission.pdf. The slides come from `deck.py`; `engine.py` writes each
one twice (PowerPoint XML into the template's own slide parts, and HTML that headless Chrome prints to PDF). No third-party packages.
The PDF step needs Google Chrome (set CHROME to its path elsewhere than macOS).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import deck  # noqa: E402
import engine as E  # noqa: E402

OUT_DIR = HERE.parent
BUILD = HERE / "build"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
DROP = {"slide2.xml", "slide15.xml"}  # the template's note to participants, and its spare blank slide


def read_template(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


def rel_targets(xml: str) -> dict[str, str]:
    out = {}
    for m in re.finditer(r"<Relationship\b[^>]*>", xml):
        tag = m.group(0)
        rid = re.search(r'Id="([^"]+)"', tag)
        tgt = re.search(r'Target="([^"]+)"', tag)
        if rid and tgt:
            out[rid.group(1)] = tgt.group(1)
    return out


def strip_text_boxes(xml: str) -> str:
    """Removes the template's own text boxes (its title and prompts); its header, footer and pictures stay."""
    return re.sub(r"<p:sp>.*?</p:sp>", lambda m: "" if 'txBox="1"' in m.group(0) else m.group(0), xml, flags=re.S)


def build_pptx(slides: list[E.Slide], template: dict[str, bytes], dest: Path) -> None:
    parts = dict(template)
    ct = parts["[Content_Types].xml"].decode()
    pres = parts["ppt/presentation.xml"].decode()
    pres_rels = parts["ppt/_rels/presentation.xml.rels"].decode()

    # Which relationship id of the presentation points at which slide part.
    rid_of = {tgt.split("/")[-1]: rid for rid, tgt in rel_targets(pres_rels).items() if tgt.startswith("slides/")}

    # Slide parts: a template slide keeps its own name the first time it is used; later uses are clones.
    used: dict[str, int] = {}
    next_part = 17
    plan: list[tuple[E.Slide, str]] = []
    for s in slides:
        if s.source not in used:
            used[s.source] = 1
            plan.append((s, s.source))
        else:
            plan.append((s, f"slide{next_part}.xml"))
            next_part += 1

    # Pictures this deck adds go into ppt/media under new names (the template keeps its own).
    media: dict[str, str] = {}

    def media_name(path: str) -> str:
        if path not in media:
            media[path] = f"image{100 + len(media)}.png"
            parts[f"ppt/media/{media[path]}"] = (HERE / "shots" / path).read_bytes()
        return media[path]

    new_ids: list[tuple[str, str]] = []  # (slide part, rId in the presentation)
    for s, part in plan:
        src_xml = template[f"ppt/slides/{s.source}"].decode()
        src_rels = template[f"ppt/slides/_rels/{s.source}.rels"].decode()
        xml = src_xml if s.kind == "closing" else strip_text_boxes(src_xml)
        rels = E.Rels(media_name)
        ids = E.Ids()
        added = E.elements_xml(s, ids, rels) if s.kind != "closing" else ""
        xml = xml.replace("</p:spTree>", added + "</p:spTree>")
        # A clone does not carry the template's (empty) speaker notes.
        if part != s.source:
            src_rels = re.sub(r"<Relationship\b[^>]*notesSlide[^>]*/>", "", src_rels)
        extra = ""
        for rid, typ, target, external in rels.items:
            mode = ' TargetMode="External"' if external else ""
            extra += f'<Relationship Id="{rid}" Type="{typ}" Target="{E.html.escape(target, quote=True)}"{mode}/>'
        src_rels = src_rels.replace("</Relationships>", extra + "</Relationships>")
        parts[f"ppt/slides/{part}"] = xml.encode()
        parts[f"ppt/slides/_rels/{part}.rels"] = src_rels.encode()
        if part != s.source:
            ct = ct.replace("</Types>", f'<Override ContentType="{CT_SLIDE}" PartName="/ppt/slides/{part}"/></Types>')
            rid = f"rId{200 + len(new_ids)}"
            pres_rels = pres_rels.replace("</Relationships>", f'<Relationship Id="{rid}" Type="{REL_SLIDE}" Target="slides/{part}"/></Relationships>')
            rid_of[part] = rid
        new_ids.append((part, rid_of[part]))

    # The slide list, in the new order.
    sld = "".join(f'<p:sldId id="{256 + i}" r:id="{rid}"/>' for i, (_, rid) in enumerate(new_ids))
    pres = re.sub(r"<p:sldIdLst>.*?</p:sldIdLst>", f"<p:sldIdLst>{sld}</p:sldIdLst>", pres, flags=re.S)

    # Drop the slides that are not used, with their notes and anything only they pointed at.
    keep = {part for part, _ in new_ids}
    for name in sorted({n.split("/")[-1] for n in template if n.startswith("ppt/slides/slide")} - keep):
        if name.endswith(".rels"):
            continue
        rels_xml = parts.pop(f"ppt/slides/_rels/{name}.rels", b"").decode()
        for tgt in rel_targets(rels_xml).values():
            if "notesSlide" in tgt:
                note = tgt.split("/")[-1]
                parts.pop(f"ppt/notesSlides/{note}", None)
                parts.pop(f"ppt/notesSlides/_rels/{note}.rels", None)
                ct = re.sub(rf'<Override[^>]*PartName="/ppt/notesSlides/{note}"[^>]*/>', "", ct)
        parts.pop(f"ppt/slides/{name}", None)
        ct = re.sub(rf'<Override[^>]*PartName="/ppt/slides/{name}"[^>]*/>', "", ct)
        pres_rels = re.sub(rf'<Relationship\b[^>]*Target="slides/{name}"[^>]*/>', "", pres_rels)
    # Media that no kept part uses any more (the template's note picture).
    referenced = " ".join(v.decode("utf-8", "ignore") for k, v in parts.items() if k.endswith(".rels"))
    for k in [k for k in parts if k.startswith("ppt/media/")]:
        if k.split("/")[-1] not in referenced:
            parts.pop(k)

    parts["[Content_Types].xml"] = ct.encode()
    parts["ppt/presentation.xml"] = pres.encode()
    parts["ppt/_rels/presentation.xml.rels"] = pres_rels.encode()

    dest.parent.mkdir(parents=True, exist_ok=True)
    order = ["[Content_Types].xml"] + [n for n in parts if n != "[Content_Types].xml"]
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for n in order:
            z.writestr(n, parts[n])


CSS = f"""
@page {{ size: 10in 5.625in; margin: 0 }}
* {{ box-sizing: border-box }}
html, body {{ margin: 0; padding: 0; background: #fff }}
body {{ font-family: {E.CSS_FONT}; color: #{E.INK}; -webkit-font-smoothing: antialiased }}
.slide {{ position: relative; width: 10in; height: 5.625in; overflow: hidden; page-break-after: always; break-after: page; background: #fff }}
.slide:last-child {{ page-break-after: auto; break-after: auto }}
.box {{ position: absolute; display: flex; flex-direction: column; overflow: visible }}
.box p {{ line-height: 1.2 }}
img {{ position: absolute }}
svg.lines {{ position: absolute; left: 0; top: 0; pointer-events: none }}
.strip {{ position: absolute; left: 0; top: 5.57in; width: 10in; height: 0.0594in; background-size: 10in 2.97in; background-position: top; background-image: url(media/image3.png) }}
.footbar {{ position: absolute; left: 0; top: 5.547in; width: 10in; height: 0.107in; background: #000 }}
"""

QA_JS = """
const out = [];
document.querySelectorAll('.slide').forEach((sl, i) => {
  sl.querySelectorAll('.box').forEach((b) => {
    if (b.scrollHeight > b.clientHeight + 2 || b.scrollWidth > b.clientWidth + 2) {
      out.push('slide ' + (i + 1) + ': ' + b.dataset.name + ' overflows (' + b.scrollHeight + ' > ' + b.clientHeight + ') "' + b.innerText.slice(0, 50).replace(/\\n/g, ' ') + '"');
    }
  });
});
document.getElementById('qa').textContent = JSON.stringify(out);
"""


def build_html(slides: list[E.Slide], template: dict[str, bytes]) -> Path:
    BUILD.mkdir(parents=True, exist_ok=True)
    (BUILD / "media").mkdir(exist_ok=True)
    (BUILD / "shots").mkdir(exist_ok=True)
    for n in ("image2.png", "image3.png", "image4.png", "image5.png"):
        (BUILD / "media" / n).write_bytes(template[f"ppt/media/{n}"])
    for f in (HERE / "shots").glob("*.png"):
        shutil.copy(f, BUILD / "shots" / f.name)
    pages = []
    for s in slides:
        body = ""
        lines = [e for e in s.elements if isinstance(e, E.Line)]
        if s.kind == "closing":
            body += '<img src="media/image5.png" style="left:0;top:0;width:10in;height:5.625in"><div class="strip"></div>'
        elif s.kind == "cover":
            body += '<img src="media/image4.png" style="left:0;top:0;width:10in;height:2.9697in"><div class="strip"></div>'
        else:
            body += '<img src="media/image2.png" style="left:0;top:0;width:10in;height:0.5549in"><div class="footbar"></div><div class="strip"></div>'
        for e in s.elements:
            if isinstance(e, E.Box):
                body += E.box_html(e)
            elif isinstance(e, E.Pic):
                body += E.pic_html(e, f"shots/{e.path}")
        body += E.lines_svg(lines)
        pages.append(f'<section class="slide">{body}</section>')
    doc = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Worktrees Studio, AI Builder Cup submission</title><style>{CSS}</style></head><body>{"".join(pages)}<pre id="qa" hidden></pre><script>{QA_JS}</script></body></html>'
    path = BUILD / "submission.html"
    path.write_text(doc, encoding="utf-8")
    return path


def chrome(*args: str, timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", *args], capture_output=True, text=True, timeout=timeout)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", default="Worktrees Studio")
    ap.add_argument("--leader", default="Nucky Ridwan Gunawan")
    ap.add_argument("--video-url", default=None)
    ap.add_argument("--no-pdf", action="store_true")
    ap.add_argument("--screens", action="store_true", help="also write one PNG per slide (build/slide-N.png) for checking")
    a = ap.parse_args()

    template = read_template(HERE / "template.pptx")
    summary = json.loads((HERE / "eval-summary.json").read_text())
    run = HERE / "pipeline-run.json"
    if run.exists():
        summary["pipeline"] = json.loads(run.read_text())
    slides = deck.build(a.team, a.leader, a.video_url, summary)

    pptx = OUT_DIR / "submission.pptx"
    build_pptx(slides, template, pptx)
    print(f"wrote {pptx.relative_to(OUT_DIR.parent.parent)} ({pptx.stat().st_size // 1024} KB, {len(slides)} slides)")

    html_path = build_html(slides, template)
    r = chrome("--virtual-time-budget=4000", "--dump-dom", html_path.as_uri())
    m = re.search(r'<pre id="qa"[^>]*>(.*?)</pre>', r.stdout, re.S)
    problems = json.loads(__import__("html").unescape(m.group(1))) if m and m.group(1).strip() else []
    for p in problems:
        print("OVERFLOW", p)
    if not a.no_pdf:
        pdf = OUT_DIR / "submission.pdf"
        chrome("--no-pdf-header-footer", f"--print-to-pdf={pdf}", html_path.as_uri())
        print(f"wrote {pdf.relative_to(OUT_DIR.parent.parent)} ({pdf.stat().st_size // 1024} KB)")
    if a.screens:
        shot = BUILD / "all.png"
        chrome("--force-device-scale-factor=2", f"--window-size=960,{540 * len(slides)}", f"--screenshot={shot}", html_path.as_uri())
        for i in range(len(slides)):
            subprocess.run(["magick", str(shot), "-crop", f"1920x1080+0+{i * 1080}", "+repage", str(BUILD / f"slide-{i + 1:02d}.png")], check=True)
        print(f"wrote {len(slides)} slide images to {BUILD}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
