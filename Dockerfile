# Multi-stage build: компилируем TypeScript в одном слое, копируем dist в финальный.
# Финальный образ — slim Node без devDependencies и TS-toolchain.

FROM node:20-alpine AS build
WORKDIR /app

# Сначала только package.json — кеш слоя deps пересобирается только при изменении манифеста.
COPY package.json ./
RUN npm install --no-audit --no-fund

# Исходники + tsconfig
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Удаляем devDependencies для финального образа.
RUN npm prune --production


FROM node:20-alpine
WORKDIR /app

# Не запускаем как root — Alpine имеет встроенного `node` пользователя.
ENV NODE_ENV=production
ENV MCP_PORT=8080
EXPOSE 8080

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./

USER node

# Health-check для Dokploy / orchestrator'а.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --spider http://localhost:${MCP_PORT}/health || exit 1

CMD ["node", "dist/index.js"]
