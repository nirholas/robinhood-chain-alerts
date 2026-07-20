# hood-alerts service image.
#   docker build -t hood-alerts .
#   docker run --rm -p 8080:8080 -v hood-alerts-data:/app/data \
#     -e TELEGRAM_BOT_TOKEN=... hood-alerts
FROM node:22-slim AS build
WORKDIR /app

# Install with dev dependencies so the TypeScript build can run, then build.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Reinstall production-only dependencies for the runtime layer. `hoodchain`,
# `hoodkit` and `viem` are peer dependencies, so they are installed explicitly:
# a peer is a contract with the consumer, and the image is the consumer.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm install --no-save --omit=dev --no-audit --no-fund \
     hoodchain@^0.1.1 hoodkit@^0.1.0 viem@^2.55.0

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json

RUN mkdir -p /app/data \
  && useradd --system --uid 10001 hoodalerts \
  && chown -R hoodalerts /app
USER hoodalerts

EXPOSE 8080
ENV PORT=8080
ENV DB_PATH=/app/data/hood-alerts.sqlite

# /ready reports 503 when the poll loop has stalled, so an orchestrator
# restarts a service that is alive but no longer ingesting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "dist/service/main.js"]
