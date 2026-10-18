"""A tiny slide engine: one description of a slide, two outputs.

The cup's submission template is a PowerPoint file, and the deck also has to be a PDF. There is no PowerPoint or LibreOffice on the
machine that builds it, so each slide is described once here (text boxes, rectangles, lines and pictures, in inches on the
template's 10 x 5.625 inch slide) and written twice: as `<p:sp>`/`<p:pic>`/`<p:cxnSp>` XML for the template's slide parts, and as
absolutely positioned HTML that headless Chrome prints to PDF. Standard library only.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

EMU = 914400
SLIDE_W, SLIDE_H = 10.0, 5.625

# The cup's own look: white slides, black header and footer, Google colours for emphasis.
INK = "1F1F1F"
MUTED = "5F6368"
WHITE = "FFFFFF"
BLACK = "000000"
LINE = "DADCE0"
CARD = "F1F3F4"
BLUE, BLUE_T = "1A73E8", "E8F0FE"
GREEN, GREEN_T = "188038", "E6F4EA"
AMBER, AMBER_T = "B06000", "FEF7E0"
RED, RED_T = "C5221F", "FCE8E6"
PURPLE, PURPLE_T = "7627BB", "F3E8FD"

BODY_FONT = "Google Sans Flex"
MEDIUM_FONT = "Google Sans Flex Medium"
SEMI_FONT = "Google Sans Flex SemiBold"
# What the PDF is drawn with (the template's own font is not installable here).
CSS_FONT = "'Google Sans Flex','Google Sans',Arial,'Helvetica Neue',sans-serif"


def emu(v: float) -> int:
    return int(round(v * EMU))


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ───────────────────────── text ─────────────────────────


@dataclass
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    color: str | None = None
    size: float | None = None
    font: str | None = None
    link: str | None = None


@dataclass
class Para:
    runs: list[Run]
    size: float = 11
    color: str = INK
    bold: bool = False
    font: str = BODY_FONT
    bullet: bool = False
    num: bool = False  # a, b, c ... (the cover's list)
    align: str = "l"
    before: float = 0
    after: float = 3
    indent: float = 0.17
    left: float = 0.0  # extra left margin, inches


_BOLD = re.compile(r"(\*\*.+?\*\*)")


def P(text: str = "", **kw) -> Para:
    """A paragraph. `**bold**` inside the text makes a bold run; pass `runs=[...]` for anything fancier."""
    runs = kw.pop("runs", None)
    if runs is None:
        runs = []
        for part in _BOLD.split(text):
            if not part:
                continue
            if part.startswith("**") and part.endswith("**"):
                runs.append(Run(part[2:-2], bold=True))
            else:
                runs.append(Run(part))
    return Para(runs=runs, **kw)


# ───────────────────────── elements ─────────────────────────


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float
    paras: list[Para] = field(default_factory=list)
    fill: str | None = None
    line: str | None = None
    line_w: float = 0.75
    radius: float = 0.0  # inches; 0 = square corners
    anchor: str = "t"  # t | ctr | b
    pad: tuple[float, float, float, float] = (0.08, 0.05, 0.08, 0.05)  # l t r b
    name: str = "Box"
    text_box: bool = False


@dataclass
class Line:
    x1: float
    y1: float
    x2: float
    y2: float
    color: str = MUTED
    width: float = 1.25
    arrow: bool = True
    dash: bool = False
    name: str = "Line"


@dataclass
class Pic:
    x: float
    y: float
    w: float
    h: float
    path: str
    alt: str = ""
    line: str | None = LINE


@dataclass
class Slide:
    kind: str  # cover | content | closing
    source: str  # the template slide part this one is made from
    title: str = ""
    elements: list = field(default_factory=list)
    notes: str = ""

    def add(self, *els):
        self.elements.extend(els)
        return self


def Text(x, y, w, h, *paras, **kw) -> Box:
    kw.setdefault("text_box", True)
    kw.setdefault("name", "Text")
    return Box(x, y, w, h, list(paras), **kw)


def Card(x, y, w, h, *paras, fill=CARD, line=None, radius=0.1, **kw) -> Box:
    kw.setdefault("name", "Card")
    kw.setdefault("pad", (0.12, 0.09, 0.12, 0.08))
    return Box(x, y, w, h, list(paras), fill=fill, line=line, radius=radius, **kw)


# ───────────────────────── PPTX output ─────────────────────────


class Ids:
    """Shape ids unique within one slide (the template's own go up to ~170)."""

    def __init__(self, start: int = 300):
        self.n = start

    def next(self) -> int:
        self.n += 1
        return self.n


def _rpr(r: Run, p: Para, tag: str = "a:rPr", rel: str | None = None) -> str:
    size = r.size or p.size
    font = r.font or p.font
    color = r.color or p.color
    bold = r.bold or p.bold
    attrs = f'lang="en-GB" sz="{int(round(size * 100))}" b="{1 if bold else 0}" i="{1 if r.italic else 0}" dirty="0"'
    link = f'<a:hlinkClick r:id="{rel}"/>' if rel else ""
    return (
        f'<{tag} {attrs}><a:solidFill><a:srgbClr val="{color}"/></a:solidFill>'
        f'<a:latin typeface="{font}"/><a:ea typeface="{font}"/><a:cs typeface="{font}"/><a:sym typeface="{font}"/>{link}</{tag}>'
    )


def _para_xml(p: Para, rels: "Rels", num_state: dict) -> str:
    size = p.size
    mar = emu(p.left + p.indent) if p.bullet else emu(p.left)
    ind = -emu(p.indent) if p.bullet else 0
    if p.num:
        bu = f'<a:buSzPts val="{int(size * 100)}"/><a:buFont typeface="{BODY_FONT}"/><a:buAutoNum type="alphaLcPeriod"/>'
        mar, ind = emu(1.0), -emu(0.375)  # the template's own lettered list
    elif p.bullet:
        bu = f'<a:buSzPts val="{int(size * 100)}"/><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>'
    else:
        bu = "<a:buNone/>"
    ppr = (
        f'<a:pPr marL="{mar}" lvl="0" indent="{ind}" algn="{p.align}" rtl="0">'
        f'<a:lnSpc><a:spcPct val="100000"/></a:lnSpc>'
        f'<a:spcBef><a:spcPts val="{int(p.before * 100)}"/></a:spcBef><a:spcAft><a:spcPts val="{int(p.after * 100)}"/></a:spcAft>{bu}</a:pPr>'
    )
    runs = ""
    for r in p.runs:
        rel = rels.link(r.link) if r.link else None
        runs += f'<a:r>{_rpr(r, p, rel=rel)}<a:t>{esc(r.text)}</a:t></a:r>'
    end = f'<a:endParaRPr lang="en-GB" sz="{int(size * 100)}" dirty="0"><a:latin typeface="{p.font}"/></a:endParaRPr>'
    return f"<a:p>{ppr}{runs}{end}</a:p>"


class Rels:
    """The relationships a slide gains while it is written: pictures and external links."""

    def __init__(self, media_namer, start: int = 100):
        self.items: list[tuple[str, str, str, bool]] = []  # id, type, target, external
        self.n = start
        self.media_namer = media_namer
        self.pics: dict[str, str] = {}
        self.links: dict[str, str] = {}

    def picture(self, path: str) -> str:
        if path not in self.pics:
            self.n += 1
            rid = f"rId{self.n}"
            target = self.media_namer(path)
            self.pics[path] = rid
            self.items.append((rid, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", f"../media/{target}", False))
        return self.pics[path]

    def link(self, url: str) -> str:
        if url not in self.links:
            self.n += 1
            rid = f"rId{self.n}"
            self.links[url] = rid
            self.items.append((rid, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", url, True))
        return self.links[url]


def _fill(fill: str | None) -> str:
    return f'<a:solidFill><a:srgbClr val="{fill}"/></a:solidFill>' if fill else "<a:noFill/>"


def _ln(color: str | None, w: float) -> str:
    if not color:
        return "<a:ln><a:noFill/></a:ln>"
    return f'<a:ln w="{int(w * 12700)}"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:ln>'


def box_xml(b: Box, ids: Ids, rels: Rels) -> str:
    sid = ids.next()
    shape = "roundRect" if b.radius > 0 else "rect"
    adj = ""
    if b.radius > 0:
        val = min(50000, int(b.radius / min(b.w, b.h) * 100000))
        adj = f'<a:gd name="adj" fmla="val {val}"/>'
    l, t, r, bt = (emu(v) for v in b.pad)
    paras = "".join(_para_xml(p, rels, {}) for p in b.paras) or '<a:p><a:endParaRPr lang="en-GB" sz="1000"/></a:p>'
    txbox = ' txBox="1"' if b.text_box else ""
    return (
        f'<p:sp><p:nvSpPr><p:cNvPr id="{sid}" name="{esc(b.name)} {sid}"/><p:cNvSpPr{txbox}/><p:nvPr/></p:nvSpPr>'
        f'<p:spPr><a:xfrm><a:off x="{emu(b.x)}" y="{emu(b.y)}"/><a:ext cx="{emu(b.w)}" cy="{emu(b.h)}"/></a:xfrm>'
        f'<a:prstGeom prst="{shape}"><a:avLst>{adj}</a:avLst></a:prstGeom>{_fill(b.fill)}{_ln(b.line, b.line_w)}</p:spPr>'
        f'<p:txBody><a:bodyPr wrap="square" lIns="{l}" tIns="{t}" rIns="{r}" bIns="{bt}" anchor="{b.anchor}" anchorCtr="0" spcFirstLastPara="1"><a:noAutofit/></a:bodyPr>'
        f"<a:lstStyle/>{paras}</p:txBody></p:sp>"
    )


def line_xml(ln: Line, ids: Ids) -> str:
    sid = ids.next()
    x, y = min(ln.x1, ln.x2), min(ln.y1, ln.y2)
    w, h = abs(ln.x2 - ln.x1), abs(ln.y2 - ln.y1)
    flips = (' flipH="1"' if ln.x2 < ln.x1 else "") + (' flipV="1"' if ln.y2 < ln.y1 else "")
    dash = '<a:prstDash val="dash"/>' if ln.dash else ""
    arrow = '<a:tailEnd type="triangle" w="med" len="med"/>' if ln.arrow else ""
    return (
        f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{sid}" name="{esc(ln.name)} {sid}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
        f'<p:spPr><a:xfrm{flips}><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm>'
        f'<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="{int(ln.width * 12700)}"><a:solidFill><a:srgbClr val="{ln.color}"/></a:solidFill>{dash}{arrow}</a:ln></p:spPr></p:cxnSp>'
    )


def pic_xml(p: Pic, ids: Ids, rels: Rels) -> str:
    sid = ids.next()
    rid = rels.picture(p.path)
    return (
        f'<p:pic><p:nvPicPr><p:cNvPr id="{sid}" name="Picture {sid}" descr="{html.escape(p.alt, quote=True)}"/>'
        f'<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
        f'<p:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
        f'<p:spPr><a:xfrm><a:off x="{emu(p.x)}" y="{emu(p.y)}"/><a:ext cx="{emu(p.w)}" cy="{emu(p.h)}"/></a:xfrm>'
        f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{_ln(p.line, 0.75)}</p:spPr></p:pic>'
    )


def elements_xml(slide: Slide, ids: Ids, rels: Rels) -> str:
    out = []
    for e in slide.elements:
        if isinstance(e, Box):
            out.append(box_xml(e, ids, rels))
        elif isinstance(e, Line):
            out.append(line_xml(e, ids))
        elif isinstance(e, Pic):
            out.append(pic_xml(e, ids, rels))
        else:
            raise TypeError(e)
    return "".join(out)


def title_box(text: str) -> Box:
    """The template's own title: 16 pt Medium at the same place on every content slide."""
    return Text(0.29, 0.725, 9.78, 0.61, P(text, size=16, font=MEDIUM_FONT, after=0), pad=(0.1, 0.1, 0.1, 0.1), name="Title")


# ───────────────────────── HTML output ─────────────────────────


def _css_para(p: Para, letter: str | None) -> str:
    size = p.size
    weight = 700 if p.bold or p.font in (MEDIUM_FONT, SEMI_FONT) else 400
    style = f"font-size:{size}pt;color:#{p.color};font-weight:{weight};text-align:{'left' if p.align == 'l' else 'center' if p.align == 'ctr' else 'right'};margin:{p.before}pt 0 {p.after}pt 0;"
    if p.num:
        style += "padding-left:1in;text-indent:-0.375in;"
    elif p.bullet:
        style += f"padding-left:{p.left + p.indent}in;text-indent:-{p.indent}in;"
    elif p.left:
        style += f"padding-left:{p.left}in;"
    marker = ""
    if p.num and letter:
        marker = f'<span style="display:inline-block;width:0.375in;text-indent:0">{letter}.</span>'
    elif p.bullet:
        marker = f'<span style="display:inline-block;width:{p.indent}in;text-indent:0">&#8226;</span>'
    runs = ""
    for r in p.runs:
        rs = ""
        if r.bold:
            rs += "font-weight:700;"
        if r.italic:
            rs += "font-style:italic;"
        if r.color:
            rs += f"color:#{r.color};"
        if r.size:
            rs += f"font-size:{r.size}pt;"
        if r.font in (MEDIUM_FONT, SEMI_FONT):
            rs += "font-weight:700;"
        txt = html.escape(r.text)
        if r.link:
            txt = f'<a href="{html.escape(r.link, quote=True)}" style="color:inherit;text-decoration:underline">{txt}</a>'
        runs += f'<span style="{rs}">{txt}</span>' if rs else txt
    return f'<p style="{style}">{marker}{runs or "&nbsp;"}</p>'


def box_html(b: Box) -> str:
    l, t, r, bt = b.pad
    bg = f"background:#{b.fill};" if b.fill else ""
    border = f"border:{b.line_w}pt solid #{b.line};" if b.line else ""
    rad = f"border-radius:{b.radius}in;" if b.radius else ""
    just = {"t": "flex-start", "ctr": "center", "b": "flex-end"}[b.anchor]
    letters = iter("abcdefghijklmnopqrstuvwxyz")
    body = "".join(_css_para(p, next(letters) if p.num else None) for p in b.paras)
    return (
        f'<div class="box" style="left:{b.x}in;top:{b.y}in;width:{b.w}in;height:{b.h}in;padding:{t}in {r}in {bt}in {l}in;'
        f'justify-content:{just};{bg}{border}{rad}" data-name="{html.escape(b.name)}">{body}</div>'
    )


def pic_html(p: Pic, src: str) -> str:
    border = f"border:0.75pt solid #{p.line};" if p.line else ""
    return f'<img src="{src}" alt="{html.escape(p.alt, quote=True)}" style="left:{p.x}in;top:{p.y}in;width:{p.w}in;height:{p.h}in;{border}">'


def lines_svg(lines: list[Line]) -> str:
    """All of a slide's lines and arrows in one SVG laid over it (96 px per inch, like the rest of the page)."""
    if not lines:
        return ""
    px = lambda v: round(v * 96, 2)
    colors = sorted({l.color for l in lines if l.arrow})
    defs = "".join(
        f'<marker id="m{c}" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#{c}"/></marker>'
        for c in colors
    )
    body = ""
    for l in lines:
        dash = ' stroke-dasharray="5 4"' if l.dash else ""
        marker = f' marker-end="url(#m{l.color})"' if l.arrow else ""
        body += f'<line x1="{px(l.x1)}" y1="{px(l.y1)}" x2="{px(l.x2)}" y2="{px(l.y2)}" stroke="#{l.color}" stroke-width="{round(l.width * 96 / 72, 2)}"{dash}{marker}/>'
    w, h = px(SLIDE_W), px(SLIDE_H)
    return f'<svg class="lines" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><defs>{defs}</defs>{body}</svg>'
