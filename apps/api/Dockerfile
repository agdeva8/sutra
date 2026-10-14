# The Sutra API with agentv2 in-process. Build from the REPO ROOT so both packages are in the context:
#
#   docker build -f apps/api/Dockerfile -t sutra-api .
#
# Configuration is environment only (see docs/DEPLOY.md); no .env file is baked in.
FROM python:3.12-slim

# Both packages are installed (not editable) from their own folders.
WORKDIR /srv
COPY apps/agentv2 /srv/agentv2
COPY apps/api /srv/api
RUN pip install --no-cache-dir /srv/agentv2 /srv/api

WORKDIR /srv/api
RUN chmod +x scripts/docker-entrypoint.sh \
    && useradd --create-home --uid 10001 sutra \
    && chown -R sutra /srv/api
USER sutra

ENV PORT=8000 \
    RUN_MIGRATIONS=1 \
    PYTHONUNBUFFERED=1
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health',timeout=4)"

ENTRYPOINT ["scripts/docker-entrypoint.sh"]
