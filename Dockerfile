# HTB LLM (unofficial) — образ веб-приложения.
# Серверу нужен Docker socket хоста: отдельные Kali-контейнеры задач создаёт host daemon.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git g++ make python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    WH_HOST=0.0.0.0 \
    WH_PORT=7331 \
    WH_DATA=/data \
    WH_SERVICES=off \
    WH_BROWSER_PATH=/usr/bin/chromium \
    HOME=/tmp
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation git tini \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/knowledge ./knowledge
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/tsconfig.json ./tsconfig.json
EXPOSE 7331
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/server/index.ts"]
