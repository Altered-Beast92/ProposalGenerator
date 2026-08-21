# Build context is the REPOSITORY ROOT, not this directory: the renderer reads
# the shared spec from packages/spec, so both have to be in the image.
#
#   docker build -f services/renderer/Dockerfile -t proposal-renderer .
#
# On Railway/Render, set the Dockerfile path to services/renderer/Dockerfile and
# leave the build context at the repo root.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY services/renderer/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Mirrors the repo layout, because replay.py resolves the spec relative to its
# own location (parents[2]/packages/spec).
COPY packages/spec ./packages/spec
COPY services/renderer/*.py ./services/renderer/

WORKDIR /app/services/renderer

# Hosts inject the port; default matches the local dev port.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
