# Derleme bağlamı: depo kökü (pnpm workspace)
FROM node:24-alpine AS build
WORKDIR /w
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/ingestion/package.json apps/ingestion/
RUN pnpm install --frozen-lockfile --filter @vmes/ingestion...
COPY packages/contracts packages/contracts
COPY apps/ingestion apps/ingestion
RUN pnpm --filter @vmes/contracts build && pnpm --filter @vmes/ingestion build \
 && pnpm --filter @vmes/ingestion deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3001
CMD ["node", "dist/src/main.js"]
