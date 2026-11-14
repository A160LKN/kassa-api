# Сборка: TypeScript → JavaScript
FROM node:25-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build && npm prune --omit=dev

# Запуск: только собранный код и рабочие зависимости
FROM node:25-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY drizzle drizzle
COPY package.json .
USER node
EXPOSE 3000
# При старте: миграции (и демо-данные, если SEED_DEMO=true), затем сервер
CMD ["node", "dist/server.js"]
