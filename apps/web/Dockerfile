# Web app (Next.js) for the one-command demo: `docker compose up --build`
# (service "web" of docker-compose.yml). Build context: the repository root,
# since the app is a pnpm workspace package.
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

WORKDIR /repo

# Dependencies first, in their own cached layer. The schema is needed by the
# postinstall `prisma generate`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/web/prisma apps/web/prisma
RUN pnpm install --frozen-lockfile

# NEXT_PUBLIC_* values are inlined at build time.
ARG NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
ENV NEXT_PUBLIC_MAP_STYLE_URL=$NEXT_PUBLIC_MAP_STYLE_URL
COPY apps/web apps/web
RUN pnpm --filter web build

ENV NODE_ENV=production
WORKDIR /repo/apps/web
EXPOSE 3100
CMD ["sh", "docker/start.sh"]
