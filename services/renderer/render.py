"""CLI entry point for the proposal renderer.

    python render.py --template seo-only --out build/out.pdf
    python render.py --template seo-ads --theme theme.json --out build/out.pdf

`--theme` takes a JSON object of palette role -> hex, e.g.
`{"primary": "#0B6E4F", "secondary": "#F4A300"}`. Roles left out keep their
default. `--content` takes a JSON object of "<page>:<run-index>" -> replacement
string.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from palette import Palette
from replay import Replayer


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Render a proposal PDF from a frozen layout spec.")
    ap.add_argument("--template", required=True, help="layout spec name, e.g. seo-only")
    ap.add_argument("--out", required=True, type=Path, help="output PDF path")
    ap.add_argument("--theme", type=Path, help="JSON file of palette role -> hex")
    ap.add_argument("--content", type=Path, help="JSON file of run key -> replacement text")
    ap.add_argument(
        "--replace",
        type=Path,
        help='JSON object of find -> replace, applied to every text run. '
        'Used for deck-wide swaps such as the business name, which appears '
        'on the cover and in every page footer.',
    )
    ap.add_argument(
        "--logos",
        type=Path,
        help='JSON object of frame name -> image path, e.g. '
        '{"clientLogo": "logo.png", "presenterLogo": "wppro.png"}',
    )
    ap.add_argument(
        "--keep-empty-logo-panels",
        action="store_true",
        help="draw logo panels even when no logo is supplied. Off by default, "
        "because an empty frame prints as a bare white box; the fidelity gate "
        "turns it on to compare against the unmodified golden deck.",
    )
    ap.add_argument(
        "--icon-style",
        choices=("none", "vector", "font"),
        default="none",
        help="what to put inside the page-4 badges. 'none' (default) leaves "
        "them empty, matching the SEO-only deck. 'vector' draws a tick or "
        "warning mark. 'font' typesets the original symbol code points, which "
        "ReportLab renders as filled boxes - only the fidelity gate wants it, "
        "so run counts still match the golden deck.",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero if any text run overflows the space the design gave it",
    )
    args = ap.parse_args(argv)

    theme = json.loads(args.theme.read_text(encoding="utf-8")) if args.theme else None
    content = json.loads(args.content.read_text(encoding="utf-8")) if args.content else None

    try:
        palette = Palette.load(theme)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    replacements = None
    if args.replace:
        raw = json.loads(args.replace.read_text(encoding="utf-8"))
        replacements = [(k, v) for k, v in raw.items() if not k.startswith("$")]

    logos = None
    if args.logos:
        raw = json.loads(args.logos.read_text(encoding="utf-8"))
        logos = {k: v for k, v in raw.items() if not k.startswith("$") and v}

    replayer = Replayer(
        args.template,
        palette=palette,
        content=content,
        replacements=replacements,
        logos=logos,
        keep_empty_logo_panels=args.keep_empty_logo_panels,
        icon_style=args.icon_style,
    )
    report = replayer.render(args.out)

    print(
        f"{args.template}: {report.pages} pages, {report.shapes} shapes, "
        f"{report.runs} runs, {report.substitutions} substitutions, "
        f"{report.logos_drawn} logo(s) -> {args.out}"
    )
    for note in report.logo_notes:
        print(f"  logo: {note}", file=sys.stderr)
    if report.unmapped_colours:
        print(f"  note: {len(report.unmapped_colours)} colour(s) have no role and cannot be themed:")
        for colour in report.unmapped_colours:
            print(f"    {colour}")
    if report.overflows:
        print(f"  {len(report.overflows)} overflow(s):", file=sys.stderr)
        for line in report.overflows[:20]:
            print(f"    {line}", file=sys.stderr)
        if args.strict:
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
