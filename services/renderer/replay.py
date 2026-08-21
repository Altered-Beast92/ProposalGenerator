"""Replays an extracted geometry spec back out as a PDF.

This is the piece that makes "nothing moves" true by construction. The renderer
has no layout engine: it cannot create a frame, reflow a paragraph or nudge a
margin. It walks the coordinates recorded from the golden deck and draws exactly
what was there, substituting only two things - the colour of a mark, and the
string inside a text run.

That inversion is deliberate. Content is forced to fit a fixed layout rather
than layout bending to fit content.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

from palette import Palette

SPEC_DIR = Path(__file__).resolve().parents[2] / "packages" / "spec"
LAYOUT_DIR = SPEC_DIR / "layouts"
CONTENT_DIR = SPEC_DIR / "content"


@dataclass
class RenderReport:
    """What happened during a render, for the verification step to assert on."""

    pages: int = 0
    shapes: int = 0
    runs: int = 0
    substitutions: int = 0
    logos_drawn: int = 0
    panels_hidden: int = 0
    icons_drawn: int = 0
    overflows: list[str] = field(default_factory=list)
    logo_notes: list[str] = field(default_factory=list)
    unmapped_colours: list[str] = field(default_factory=list)


class Replayer:
    def __init__(
        self,
        template: str,
        palette: Palette | None = None,
        content: dict[str, str] | None = None,
        replacements: list[tuple[str, str]] | None = None,
        logos: dict[str, str] | None = None,
        keep_empty_logo_panels: bool = False,
        icon_style: str = "none",
    ) -> None:
        path = LAYOUT_DIR / f"{template}.geometry.json"
        if not path.exists():
            # .stem only strips ".json", leaving a misleading ".geometry" tail.
            available = ", ".join(
                sorted(p.name.removesuffix(".geometry.json") for p in LAYOUT_DIR.glob("*.geometry.json"))
            )
            raise FileNotFoundError(f"no layout spec for '{template}'. available: {available}")

        self.spec = json.loads(path.read_text(encoding="utf-8"))
        self.template = template
        self.palette = palette or Palette.load()
        # Keyed "<page>:<index>" so a substitution targets one specific run and
        # can never accidentally rewrite a repeated string elsewhere.
        self.content = content or {}
        # Applied to every run, longest pattern first so that replacing a short
        # name cannot chew a hole in a longer one that contains it.
        self.replacements = sorted(replacements or [], key=lambda kv: -len(kv[0]))
        self.report = RenderReport()

        # The slot schema carries two things the raw geometry cannot: how much
        # room a run actually has (rather than how much its original text used),
        # and which way it is aligned. Without the first, overflow warnings fire
        # on copy that fits fine; without the second, replacing a right-aligned
        # footer knocks it out of alignment.
        self.slots: dict[str, dict] = {}
        slot_file = CONTENT_DIR / f"{template}.slots.json"
        if slot_file.exists():
            for slot in json.loads(slot_file.read_text(encoding="utf-8"))["slots"]:
                self.slots[slot["key"]] = slot

        # Logo images, keyed by frame name. The frames themselves come from the
        # deck; an image is fitted inside one and can never resize it.
        # How to handle the symbol-font glyphs inside the page-4 badges:
        #   none   - leave the badges empty, matching the SEO-only deck, whose
        #            badges carry no glyph at all (the default)
        #   vector - draw a tick or warning mark as vector art
        #   font   - typeset the original code points; only the fidelity gate
        #            wants this, since ReportLab draws them as filled boxes
        self.icon_style = icon_style
        self.logos = logos or {}
        self.logo_frames: dict[str, dict] = {}
        logo_file = CONTENT_DIR / "logos.json"
        if logo_file.exists():
            spec = json.loads(logo_file.read_text(encoding="utf-8"))
            self.logo_frames = spec.get(template, {})

        # An unfilled logo frame would otherwise print as a bare white box on
        # the cover, which looks like a mistake. The panels are suppressed when
        # no image is supplied for them. The fidelity gate passes
        # keep_empty_logo_panels so it still compares against the golden deck,
        # where the panels are always drawn.
        self.suppressed_panels: list[dict] = []
        if not keep_empty_logo_panels:
            for name, frame in self.logo_frames.items():
                panel = frame.get("panel")
                if panel is None:
                    continue  # nothing behind this frame to hide

                moved = any(
                    abs(panel[k] - frame[k]) > 1 for k in ("x", "y", "w", "h")
                )
                # Hide the panel when it has nothing in it, and also when the
                # frame has been repositioned away from it - otherwise the
                # original white box prints on its own beside the logo.
                if moved or not self.logos.get(name):
                    self.suppressed_panels.append(panel)

    def _is_suppressed_panel(self, shape: dict) -> bool:
        """True if this shape is the backing panel of an unfilled logo frame."""
        for frame in self.suppressed_panels:
            if (
                abs(shape["x"] - frame["x"]) < 2
                and abs(shape["y"] - frame["y"]) < 2
                and abs(shape["w"] - frame["w"]) < 2
                and abs(shape["h"] - frame["h"]) < 2
            ):
                return True
        return False

    # -- drawing ---------------------------------------------------------

    def _draw_shape(self, c: rl_canvas.Canvas, shape: dict) -> None:
        kind = shape["kind"]
        x, y, w, h = shape["x"], shape["y"], shape["w"], shape["h"]
        radius = shape.get("radius", 0)

        if kind in ("rect", "roundRect"):
            c.setFillColor(HexColor(self.palette.resolve(shape["fill"])))
            if kind == "roundRect" and radius > 0:
                # A radius of exactly half the shorter side is a circle; clamp
                # so ReportLab does not reject an over-large corner.
                c.roundRect(x, y, w, h, min(radius, min(w, h) / 2), stroke=0, fill=1)
            else:
                c.rect(x, y, w, h, stroke=0, fill=1)
            return

        # Strokes: hairlines come through with a zero-height (or zero-width)
        # box, which has to be drawn as a line rather than a degenerate rect.
        c.setStrokeColor(HexColor(self.palette.resolve(shape["stroke"])))
        c.setLineWidth(shape.get("lineWidth", 1))
        if h == 0 or w == 0:
            c.line(x, y, x + w, y + h)
        elif kind == "roundRectOutline" and radius > 0:
            c.roundRect(x, y, w, h, min(radius, min(w, h) / 2), stroke=1, fill=0)
        else:
            c.rect(x, y, w, h, stroke=1, fill=0)

    def _draw_icon(self, c: rl_canvas.Canvas, run: dict, glyph: str) -> None:
        """
        Draws a tick or warning mark as vector art.

        The originals set these in a symbol font whose encoding does not survive
        the round trip - ReportLab's ZapfDingbats renders the same code points
        as filled boxes. Drawing the shapes directly removes the dependency on
        font encoding entirely, and makes them take the palette like everything
        else.
        """
        size = run["size"]
        x = run["x"]
        y = run["y"]
        colour = HexColor(self.palette.resolve(run["colour"]))

        c.saveState()
        c.setStrokeColor(colour)
        c.setFillColor(colour)
        c.setLineWidth(max(1.0, size * 0.13))
        c.setLineCap(1)  # round
        c.setLineJoin(1)

        if glyph in ("3", "4"):  # check marks in the source encoding
            path = c.beginPath()
            path.moveTo(x + size * 0.14, y + size * 0.42)
            path.lineTo(x + size * 0.40, y + size * 0.16)
            path.lineTo(x + size * 0.86, y + size * 0.72)
            c.drawPath(path, stroke=1, fill=0)
        else:  # "!" and anything else: an exclamation mark
            bar = max(1.0, size * 0.13)
            c.rect(x + size * 0.40, y + size * 0.30, bar, size * 0.45, stroke=0, fill=1)
            c.circle(x + size * 0.40 + bar / 2, y + size * 0.18, bar * 0.62, stroke=0, fill=1)

        c.restoreState()
        self.report.icons_drawn += 1

    def _draw_run(self, c: rl_canvas.Canvas, page_no: int, idx: int, run: dict) -> None:
        key = f"{page_no}:{idx}"
        text = self.content.get(key, run["text"])
        if key in self.content:
            self.report.substitutions += 1

        # Global find/replace runs after the per-run override, so a targeted
        # edit still picks up the business-name swap that applies deck-wide.
        for find, repl in self.replacements:
            if find and find in text:
                text = text.replace(find, repl)
                self.report.substitutions += 1

        font = self.spec["fonts"].get(run["fontId"], "Helvetica")
        size = run["size"]

        slot = self.slots.get(key, {})

        # Symbol-font glyphs are drawn as vector art rather than typeset, since
        # their encoding does not survive into ReportLab intact.
        if font == "ZapfDingbats" and self.icon_style != "font":
            if self.icon_style == "vector":
                self._draw_icon(c, run, run["text"].strip())
            return

        c.setFont(font, size)
        c.setFillColor(HexColor(self.palette.resolve(run["colour"])))

        # Unchanged text is always drawn from its recorded origin, which keeps
        # the render bit-identical to the golden deck. Right-alignment is only
        # applied to text that actually changed, and the anchor is derived from
        # ReportLab's own metrics rather than the extracted width: the two
        # disagree by fractions of a point, enough to trip the fidelity gate.
        if text != run["text"] and slot.get("align") == "right":
            right_edge = run["x"] + c.stringWidth(run["text"], font, size)
            c.drawRightString(right_edge, run["y"], text)
        else:
            c.drawString(run["x"], run["y"], text)

        # Overflow is measured against the room the slot actually has, not the
        # width the original string happened to occupy - the latter would flag
        # any replacement longer than the sample copy, however well it fits.
        allotted = slot.get("availablePt") or run.get("width", 0)
        if allotted:
            actual = c.stringWidth(text, font, size)
            if actual > allotted + 0.5:
                self.report.overflows.append(
                    f"p{page_no} run {idx}: {actual:.1f}pt of {allotted:.1f}pt "
                    f"({actual - allotted:+.1f}) {text[:40]!r}"
                )

    def _draw_logos(self, c: rl_canvas.Canvas) -> None:
        """Fits each supplied logo inside its frame, centred, aspect preserved."""
        for name, image_path in self.logos.items():
            frame = self.logo_frames.get(name)
            if not frame:
                self.report.logo_notes.append(f"no '{name}' frame in this template - skipped")
                continue
            if not Path(image_path).exists():
                self.report.logo_notes.append(f"{name}: file not found ({image_path})")
                continue

            try:
                img = ImageReader(image_path)
                iw, ih = img.getSize()
            except Exception as exc:  # unreadable or unsupported image
                self.report.logo_notes.append(f"{name}: could not read image ({exc})")
                continue

            pad = frame.get("padding", 0)
            box_w = frame["w"] - pad * 2
            box_h = frame["h"] - pad * 2
            if box_w <= 0 or box_h <= 0 or iw <= 0 or ih <= 0:
                self.report.logo_notes.append(f"{name}: frame too small to place an image")
                continue

            # Contain-fit, never upscaled past the frame.
            scale = min(box_w / iw, box_h / ih)
            draw_w = iw * scale
            draw_h = ih * scale

            # Horizontal anchoring matters: centring inside the frame makes a
            # tall logo float to the middle, so it stops lining up with the
            # text column it was meant to sit above. Frames over a plain
            # background anchor left; frames inside a white panel centre.
            align = frame.get("align", "center")
            if align == "left":
                x = frame["x"] + pad
            elif align == "right":
                x = frame["x"] + frame["w"] - pad - draw_w
            else:
                x = frame["x"] + pad + (box_w - draw_w) / 2

            valign = frame.get("valign", "center")
            if valign == "bottom":
                y = frame["y"] + pad
            elif valign == "top":
                y = frame["y"] + frame["h"] - pad - draw_h
            else:
                y = frame["y"] + pad + (box_h - draw_h) / 2

            c.drawImage(img, x, y, width=draw_w, height=draw_h, mask="auto")
            self.report.logos_drawn += 1

    # -- entry point -----------------------------------------------------

    def render(self, out_path: Path) -> RenderReport:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        pages = self.spec["pages"]
        first = pages[0]
        c = rl_canvas.Canvas(str(out_path), pagesize=(first["width"], first["height"]))
        c.setTitle(f"{self.template} proposal")

        for page in pages:
            c.setPageSize((page["width"], page["height"]))
            for shape in page["shapes"]:
                if page["page"] == 1 and self._is_suppressed_panel(shape):
                    self.report.panels_hidden += 1
                    continue
                self._draw_shape(c, shape)
                self.report.shapes += 1

            # Logo frames are all on the cover, and are drawn over the panels
            # that define them but under the text, so nothing can be obscured.
            if page["page"] == 1:
                self._draw_logos(c)

            for idx, run in enumerate(page["runs"]):
                self._draw_run(c, page["page"], idx, run)
                self.report.runs += 1
            c.showPage()
            self.report.pages += 1

        c.save()

        self.report.unmapped_colours = self.palette.unmapped(list(self.spec["palette"]))
        return self.report
