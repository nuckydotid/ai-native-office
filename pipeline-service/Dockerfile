# studio-pipeline: the private service that runs builds, tests, scans and rollouts.
# The build context is the repo root:  docker build -f pipeline-service/Dockerfile .
# It carries the sample app's baseline so the first trunk is the app in this image; deploys later advance the trunk in the bucket.
FROM oven/bun:1.4.2
WORKDIR /app
COPY pipeline-service/package.json pipeline-service/bun.lock* ./
RUN bun install --production --ignore-scripts --frozen-lockfile 2>/dev/null || bun install --production --ignore-scripts
COPY pipeline-service/src ./src
COPY sample-app /app/sample-app
ENV PORT=8080 \
    BASELINE_DIR=/app/sample-app \
    SMOKE_SCRIPT=/app/sample-app/smoke/smoke.mjs \
    PIPELINE_AUTH=google
EXPOSE 8080
USER bun
CMD ["bun", "src/index.ts"]
