FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build \
  && pnpm --filter @promptgate/gateway deploy --legacy --prod /opt/promptgate-gateway

FROM node:22-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /opt/promptgate-gateway ./

EXPOSE 8787

CMD ["node", "dist/index.js"]
