FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/node/package.json packages/node/package.json
RUN pnpm install --frozen-lockfile --filter @shardis/node...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/node packages/node
RUN pnpm --filter @shardis/node build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/node/node_modules ./packages/node/node_modules
COPY --from=build /app/packages/node/dist ./packages/node/dist
COPY --from=build /app/packages/node/package.json ./packages/node/package.json
COPY cluster.config.local.json cluster.config.render.json* ./

EXPOSE 7000
HEALTHCHECK --interval=5s --timeout=3s --retries=5 --start-period=5s \
  CMD ["node", "-e", "fetch('http://localhost:7000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "packages/node/dist/server.js"]
