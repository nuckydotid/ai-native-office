# studio-web: the Bun team server (team-server) plus the built web app, as one Cloud Run image.
# The build context is the REPO ROOT:  docker build -f deploy/web/Dockerfile .   (deploy/deploy.sh does this in Cloud Build)
# The ignore rules for this build are in deploy/web/Dockerfile.dockerignore (BuildKit reads <Dockerfile>.dockerignore).

# Stage 1: the React app (same-origin API, guest sign-in). Output: /src/dist
FROM node:22 AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts hero.ts index.html ./
COPY src src
# `npm run build` is `tsc && vite build`: a type error fails the image, which is what we want.
RUN npm run build

# Stage 2: the server (production dependencies only, from its own lockfile).
FROM oven/bun:1.4.2
WORKDIR /app
COPY team-server/package.json team-server/bun.lock team-server/
RUN cd team-server && bun install --production --ignore-scripts --frozen-lockfile
COPY team-server team-server
# The seeded demo workspaces at the repo root; the server reads the one DEMO_DATA_DIR names (docs/demo-data until the web seed goes live).
COPY docs/demo-data /app/demo-data
COPY docs/demo-data-web /app/demo-data-web
COPY --from=web /src/dist /app/web
# PORT is also set by Cloud Run; WEB_DIR is where the server finds the web build.
ENV NODE_ENV=production PORT=8080 WEB_DIR=/app/web DEMO_DATA_DIR=/app/demo-data
EXPOSE 8080
USER bun
CMD ["bun", "team-server/src/index.ts"]
