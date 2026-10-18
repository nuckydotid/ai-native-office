# The Northwind Customer Portal. The pipeline builds this file's targets; it is ours, and no change set may edit it.
#
#   deps     dependencies and Chromium, with the network on. Nothing written by an agent runs in this stage.
#   test     the hermetic runner. The pipeline starts it with `docker run --network none`.
#   runtime  what Cloud Run serves.
#
# syntax=docker/dockerfile:1
FROM node:22-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium
COPY . .
RUN npm run build
RUN npx esbuild server/index.ts --bundle --platform=node --format=esm --packages=external --outfile=server-dist/index.mjs

FROM deps AS test
ENV CI=1
ENTRYPOINT ["bash", "ci/hermetic-test.sh"]
CMD ["all"]

# What Cloud Run serves. The release scan is strict (nothing worse than medium), and it taught three things: Debian's slim image carries perl
# with five critical findings; Alpine's image ships npm, whose own bundled packages carry the next batch; and Google's distroless image
# pins an OpenSSL with critical findings. So: Alpine's current packages, upgraded, with npm and corepack removed (the app only needs Node),
# and the server bundled to one file in the deps stage.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    PORT=8080 \
    DIST_DIR=/app/dist
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=deps /app/dist ./dist
COPY --from=deps /app/server-dist ./server-dist
EXPOSE 8080
USER node
CMD ["node", "server-dist/index.mjs"]
