# syntax=docker/dockerfile:1
# World Intelligence Map – single container: API + ingestion + static web client.
# node:sqlite (built into Node ≥ 22.13) provides the database; no other services are required.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 WIM_DB_FILE=/data/live.sqlite
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/assets ./server/assets
# Adapter manifests and fixtures (fixture mode replays them) and SQL migrations are read at run time.
COPY --from=build /app/server/src/adapters ./server/src/adapters
COPY --from=build /app/server/src/store/migrations ./server/src/store/migrations
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# WIM_MODE selects live (default) or fixture.
CMD ["node", "server/dist/index.js"]
