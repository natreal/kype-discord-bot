# syntax=docker/dockerfile:1

FROM node:24-slim AS base
# Prisma picks its schema engine from the OpenSSL it finds at install time, and runs
# that engine for the migrations at boot: both stages need the same version.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY . .
ARG BUILD_COMMIT=
RUN npm ci --no-audit --no-fund \
  && BUILD_COMMIT="$BUILD_COMMIT" npm run build \
  && npm prune --omit=dev --no-audit --no-fund

FROM base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/prisma.config.ts ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts/docker ./scripts/docker
# `.run` holds the runtime markers (`/restart`). The compose file mounts a tmpfs here.
RUN mkdir .run && chown node:node .run
USER node
ENTRYPOINT ["sh", "scripts/docker/entrypoint.sh"]
