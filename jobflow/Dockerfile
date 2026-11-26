# JobFlow image: unmodified career-ops (scripts + built web app) plus the
# JobFlow layer. One image serves every role; render.yaml picks the role with
# dockerCommand. Build from the repository root:
#
#   docker build -f jobflow/Dockerfile -t jobflow .
#
# Base: the same Playwright image upstream's Dockerfile uses, so Chromium for
# PDFs and liveness checks is already inside. Upstream's Go and LaTeX extras
# are left out: they serve the terminal dashboard and the LaTeX CV path, which
# hosted users do not run.
FROM mcr.microsoft.com/playwright:v1.65.1-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# career-ops dependencies (same pin as upstream's Dockerfile).
COPY package.json ./
RUN npm install --no-audit --no-fund \
 && npm install --no-audit --no-fund --save-exact playwright@1.65.1

# Upstream web app dependencies.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund

# JobFlow dependencies.
COPY jobflow/package.json jobflow/package-lock.json ./jobflow/
RUN cd jobflow && npm ci --omit=dev --no-audit --no-fund

COPY . .
RUN cd web && npx next build

ENV NODE_ENV=production \
    CAREER_OPS_DIR=/app \
    JOBFLOW_WORK_DIR=/tmp/jobflow

# JobFlow runs as root only to hand each workspace its own uid (SANDBOX_UIDS);
# career-ops itself always runs as that per-workspace uid, never as root.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "jobflow/src/main.mjs", "app"]
