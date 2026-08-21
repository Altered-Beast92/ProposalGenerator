# Proposal Generator

Generates WPPRO search proposals as PDFs from a business's details, reproducing
two existing deck designs exactly — SEO only, and SEO + Google Ads.

## The core idea

The reference decks are treated as **frozen layouts**. Their geometry is
extracted once, and the renderer replays those coordinates verbatim. It has no
layout engine: it cannot create a frame, reflow a paragraph, or move a margin.
Only two things are substitutable — the colour of a mark (via semantic roles)
and the string inside a text run.

That inversion is the point. Content is forced to fit a fixed layout, rather
than the layout bending to fit content. "Nothing moves" is true by construction,
not by after-the-fact tidying.

Overflow is therefore a **content** problem, not a layout one. When a string is
too wide for the space the design gave it, the renderer reports it and refuses
to hide it — it will not shrink type or rewrap to compensate.

## Layout fidelity

Both decks round-trip at **0.000pt drift** across every text run and shape:

```
fidelity: seo-only
  compared 230 runs, 101 shapes
  max text drift  0.000pt   max shape drift 0.000pt   PASS

fidelity: seo-ads
  compared 414 runs, 175 shapes (6 icon runs: geometry only)
  max text drift  0.000pt   max shape drift 0.000pt   PASS
```

`verify-fidelity.mjs` is the regression gate. It re-extracts geometry from a
rendered PDF and diffs it against the stored spec, comparing colours by
*semantic role* so that intentional theming passes while a mark coming out the
wrong *kind* of colour still fails.

## Layout

| Path | What it is |
|---|---|
| `templates/golden/` | The two reference PDFs. The source of truth. |
| `tools/extract/` | Geometry extractor + fidelity verifier (Node). |
| `packages/spec/layouts/` | Extracted geometry, one JSON per template. |
| `packages/spec/palette.json` | Semantic colour roles and their aliases. |
| `services/renderer/` | ReportLab replay renderer (Python). |
| `services/renderer/themes/` | Theme files: role → hex overrides. |

## Running it

Requires **Node 20+** and **Python 3.11+** on PATH. One-time setup — installs
Node dependencies, creates the Python venv and installs ReportLab:

```bash
npm run setup
```

Render both decks to `build/`:

```bash
npm run render
```

Render one deck with a custom colour scheme:

```bash
npm run render -- seo-only --theme themes/forest.json
```

Check a render did not move anything:

```bash
npm run verify
```

Render and verify together — this is the regression gate:

```bash
npm test
```

Re-extract geometry from the golden decks (only needed if those PDFs change):

```bash
npm run extract
```

Add `--strict` to `render` to exit non-zero on any text overflow, which is what
CI should use:

```bash
npm run render -- --strict
```

### On Windows

`npm run setup` looks for a real Python via the `py` launcher first. The
Microsoft Store stub at `WindowsApps\python.exe` is not a working install — it
exits with an install prompt rather than a version — and setup will tell you so
rather than failing obscurely later.

## Notes on the source decks

Two inconsistencies in the originals are worth knowing about, both normalised
here:

- **Fonts differed.** The SEO+Ads deck was set in Helvetica (ReportLab's
  default — i.e. no font was ever chosen), while the SEO-only deck used an
  embedded face. Both now render in Helvetica.
- **Palettes differed.** The same roles used slightly different hexes across the
  two decks (`#8734EF` vs `#8A35E8` for the primary accent). Both now resolve
  through the shared roles in `packages/spec/palette.json`.

### Known gap: the six icon glyphs

Six marks (the ✓ ticks on "What's already working" and the ⚠ on "The challenge")
come from a symbol font. ZapfDingbats has no reliable reverse mapping to
unicode — pdf.js decodes *every* glyph in it as `"n"` — so their appearance
cannot be asserted programmatically, and the verifier compares them on geometry
only. They should be replaced with vector-drawn icons, which would also make
them themeable. Not yet done.

## The content schema

`packages/spec/content/*.slots.json` lists every editable text run — 230 for
seo-only, 408 for seo-ads — each with a stable key, a role (`pageTitle`,
`heading`, `body`, `eyebrow`, `stat`, `caption`, `footer`), the original text,
and a character budget.

The budget is the interesting part. The geometry records where ink *landed*, not
how much room a slot has, so budgeting off the original string length would
forbid a single extra character anywhere. Instead `build-slots.mjs` infers the
real space available to each run — the distance to the next element on that
baseline, or the enclosing card's edge, or the page margin — and the renderer
measures overflow against that.

Alignment is inferred the same way: a run sitting flush against its right bound
is right-aligned, and replacement text is anchored to that right edge so it
still finishes where the design intended. Runs whose text is unchanged are
always drawn from their recorded origin, which is what keeps the fidelity gate
at 0.000pt.

Slot files are regenerated by `npm run extract`, alongside the geometry they
derive from.

## Deployment

Everything deploys to Vercel as one project. The UI is Next.js; the renderer is
a Python serverless function beside it, because ReportLab cannot run on the Node
runtime.

| Path | Runtime | What it is |
|---|---|---|
| `apps/web/app` | Node | UI, scraper, content binding |
| `apps/web/api/render.py` | Python | ReportLab, returns the PDF |

`/api/generate` (JS) binds content to slots, then calls `/api/render` (Python)
in the same deployment.

### Vercel settings

- **Root Directory**: `apps/web`. Without it Vercel builds from the repo root,
  finds no framework, and every route 404s.
- **Include files outside the root directory**: enabled — `prebuild` reads
  `packages/spec`, one level up.
- Framework is pinned by `apps/web/vercel.json`, so the preset cannot drift back
  to "Other" (which fails the build looking for a `public` directory).

No environment variables are required.

### Why things are copied around

A serverless bundle can only see files inside its own directory, so two copies
are staged from `packages/spec`:

| Copy | Committed? | For |
|---|---|---|
| `apps/web/spec` | No — gitignored | The JS side, which imports the JSON so the bundler includes it |
| `apps/web/api/_renderer` | **Yes** | The Python function: renderer modules plus the spec it reads |

Both are regenerated by `npm run extract` (or `npm run sync-spec` directly).
`_renderer` is committed deliberately — generated files that arrive during a
build are not reliably bundled into a Python function, so it is treated like a
lockfile: regenerate, then commit whatever changed.

`replay.py` prefers a `spec/` directory beside itself and falls back to
`packages/spec`, which is what lets the same module serve both the CLI and the
deployed bundle.

### Running the renderer locally

`next dev` cannot run Vercel's Python runtime, so local development uses the
uvicorn service instead — same rendering code, different transport:

```bash
services/renderer/.venv/Scripts/python -m uvicorn server:app --port 8000 --reload
```

`/api/generate` falls back to `http://127.0.0.1:8000` when neither
`RENDERER_URL` nor `VERCEL_URL` is set. Setting `RENDERER_URL` overrides both,
which is also the escape hatch if the renderer ever needs its own host again —
`services/renderer/Dockerfile` still builds a standalone container.

### Not yet done: access control

The tool has **no authentication**. Deployed publicly, anyone with the URL gets
the agency's pricing and package structure, and can use the server to fetch
arbitrary URLs. A `middleware.js` in `apps/web` checking a shared secret is the
smallest fix; Auth.js with a domain restriction is the better one.

## Status

Built: geometry extraction, the replay renderer, semantic theming, the fidelity
gate, the content schema, and a Next.js front end (`npm run dev`).

Not yet built: the website scraper and its review step, logo upload (neither
template currently has a logo slot, so this needs a design decision first), and
UI binding for the full slot schema — the form currently edits the cover and
footer fields via deck-wide find/replace, while the renderer already accepts
slot-level edits through `--content`.

### A defect in the source deck

Page 10 of `seo-only.pdf` has its footer stamped **twice**, at identical
coordinates — `"WPPRO"` and the page footer each appear two times. It is
invisible because the copies overlap exactly, and every other page has them
once. The extraction reproduces it faithfully rather than silently repairing it,
so both copies exist in the spec as separate slots.
