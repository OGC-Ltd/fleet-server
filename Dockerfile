# syntax=docker/dockerfile:1.7
#
# One image for the server AND the report worker (different commands), so the
# two can never run different code. See docs/containerization-plan.md.
#
#   deps     npm ci with scripts (postinstall runs `prisma generate`)
#   build    tsc -> dist/ (the generated Prisma client compiles into dist/generated)
#   migrate  one-off `prisma migrate deploy`, keeps the Prisma CLI and engines
#   runtime  dist/ + production node_modules only, non-root, read-only friendly
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

FROM deps AS migrate
# A throwaway container that writes nothing but the database; not root.
USER node
ENTRYPOINT ["npx", "--no-install", "prisma", "migrate", "deploy", "--config", "prisma.config.ts"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 fleet \
 && useradd --uid 10001 --gid fleet --no-create-home --shell /usr/sbin/nologin fleet
# Code stays owned by root, so the app cannot rewrite itself; only .cache is its own.
COPY --from=build /app/node_modules ./node_modules
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
