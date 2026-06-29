FROM node:22-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npx prisma generate --schema=prisma/schema.prisma
RUN npx tsc

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated ./generated
COPY prisma ./prisma

RUN addgroup -S fleet && adduser -S fleet -G fleet
USER fleet

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
