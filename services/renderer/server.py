"""HTTP wrapper around the replay renderer.

The web app cannot spawn Python in a serverless deployment, so the renderer runs
as its own service and is called over HTTP instead. The rendering logic is
untouched - this only handles transport: decode the request, write the uploaded
logos somewhere the renderer can read them, and stream the PDF back.

Run locally:
    .venv/Scripts/python -m uvicorn server:app --port 8000 --reload
"""

from __future__ import annotations

import base64
import os
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from palette import Palette
from replay import Replayer

app = FastAPI(title="Proposal Renderer", version="0.1.0")

# The web app is deployed on a different origin, so it must be allowed through.
# ALLOWED_ORIGINS is a comma-separated list; the "*" default is only sensible
# while the tool is unauthenticated and effectively public anyway. Narrow it as
# soon as the app has a real domain.
_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

MAX_LOGO_BYTES = 5_000_000
DATA_URL = re.compile(r"^data:image/(png|jpeg|jpg|gif);base64,(.+)$", re.IGNORECASE)


class RenderRequest(BaseModel):
    template: str
    theme: dict[str, str] | None = None
    content: dict[str, str] | None = None
    replacements: dict[str, str] | None = None
    logos: dict[str, str] | None = None  # frame name -> data URL
    icon_style: str = Field(default="none", pattern="^(none|vector|font)$")
    keep_empty_logo_panels: bool = False
    strict: bool = False


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _write_logos(logos: dict[str, str] | None, tmp: Path) -> dict[str, str]:
    """Turns data URLs into files on disk, which is what the renderer expects."""
    paths: dict[str, str] = {}
    for frame, data_url in (logos or {}).items():
        match = DATA_URL.match(data_url or "")
        if not match:
            continue
        raw = base64.b64decode(match.group(2))
        if len(raw) > MAX_LOGO_BYTES:
            continue
        ext = "jpeg" if match.group(1).lower() in ("jpg", "jpeg") else match.group(1).lower()
        path = tmp / f"{frame}.{ext}"
        path.write_bytes(raw)
        paths[frame] = str(path)
    return paths


@app.post("/render")
def render(req: RenderRequest) -> Response:
    try:
        palette = Palette.load(req.theme)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    with tempfile.TemporaryDirectory(prefix="proposal-") as tmpdir:
        tmp = Path(tmpdir)
        out = tmp / "proposal.pdf"

        try:
            replayer = Replayer(
                req.template,
                palette=palette,
                content=req.content,
                replacements=list((req.replacements or {}).items()),
                logos=_write_logos(req.logos, tmp),
                keep_empty_logo_panels=req.keep_empty_logo_panels,
                icon_style=req.icon_style,
            )
            report = replayer.render(out)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if req.strict and report.overflows:
            raise HTTPException(
                status_code=422,
                detail={"error": "text overflow", "overflows": report.overflows},
            )

        pdf = out.read_bytes()

    # Diagnostics ride along in headers so the browser can surface them without
    # a second request; the body stays a plain PDF.
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "X-Overflow-Count": str(len(report.overflows)),
            "X-Overflow-Detail": " | ".join(report.overflows[:5]),
            "X-Logos-Drawn": str(report.logos_drawn),
            "X-Substitutions": str(report.substitutions),
        },
    )
