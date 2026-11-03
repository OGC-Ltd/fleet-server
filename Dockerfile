# syntax=docker/dockerfile:1.7
#
# One image for the server AND the report worker (different commands), so the
# two can never run different code. See docs/containerization-plan.md.
#
#   deps     npm ci with scripts (postinstall runs `prisma generate`)
#   build    tsc -> dist/ (the generated Prisma client compiles into dist/generated),
#            then production dependencies only (the Prisma CLI stays: it is an
#            optional peer of @prisma/client, which npm keeps)
#   migrate  one-off `prisma migrate deploy`: build's modules, CLI included
#   runtime  dist/ + production modules WITHOUT the optional peers (no Prisma
#            CLI, no typescript), non-root, read-only friendly
#
# Both shipped images take Debian's security updates and drop npm/corepack/yarn:
# nothing in them installs packages at run time, so those are only attack
# surface (and the image scan flags the copies of tar/undici that npm bundles).
#
# Pin the base by digest in CI (NODE_IMAGE build arg); the tag here matches the
# node the box and CI run today.
ARG NODE_IMAGE=node:24.20.0-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json \
 && npm prune --omit=dev --no-audit --no-fund

FROM build AS runtime-modules
RUN npm prune --omit=dev --omit=peer --no-audit --no-fund \
 && test ! -e node_modules/prisma && test ! -e node_modules/typescript

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --gid 10001 fleet \
 && useradd --uid 10001 --gid fleet --no-create-home --shell /usr/sbin/nologin fleet
ENV NODE_ENV=production
WORKDIR /app

FROM base AS migrate
# A throwaway container that writes nothing but the database; not root.
COPY --from=build /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
USER 10001:10001
ENTRYPOINT ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "prisma.config.ts"]

FROM base AS runtime
# Code stays owned by root, so the app cannot rewrite itself; only .cache is its own.
COPY --from=runtime-modules /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .geocode-cache.json .road-route-cache.json ./
COPY assets ./assets
RUN mkdir -p /app/.cache && chown fleet:fleet /app/.cache
USER 10001:10001
EXPOSE 3000
# slim has no wget/curl; node's own fetch does the check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/index.js"]
