# Northwind Customer Portal

The small web app the delivery pipeline builds, tests and ships. It is a React + Vite + TypeScript portal over synthetic orders from the
fictional Northwind Commerce, served by a tiny Hono server that also answers `/api/*`, `/healthz` and the `x-revision` header the canary
checks read.

Everything in it is invented. The public services on Cloud Run carry a synthetic-demo banner and `noindex`, and reset to this baseline
nightly.

## Run it

```sh
npm ci
npm run dev        # the portal on http://localhost:5173
npm run build      # dist/
npm start          # the server on http://localhost:8080 (serves dist, /api/*, /healthz)
```

## Check it

```sh
npm run typecheck
npm run lint
npm run test:coverage   # vitest, coverage written to coverage/coverage-summary.json
npm run e2e             # Playwright against a local vite preview
bash ci/hermetic-test.sh all   # everything, ending in the PIPELINE_RESULT line the pipeline reads
```

`ci/hermetic-test.sh` never needs the network: the `deps` image in the Dockerfile already has `node_modules` and Chromium, and the
pipeline service runs the `test` target with `docker run --network none`.

## What an agent may change

Change sets may write `src/**`, `tests/**` and `e2e/**` only. The server, the Dockerfile, the lockfile and everything in `ci/` and
`smoke/` are ours, and the pipeline refuses a change set that touches anything else or that reaches the network.

`demo/bad-orders.ts` is the seeded bad candidate: it passes the unit tests and then answers 5xx under load. Build the change set and try
it:

```sh
npm run demo:bad                                     # writes demo/bad-change-set.json against the current baseSha
node ci/apply-change-set.mjs demo/bad-change-set.json
npm test                                             # green
npm start & SMOKE_BASE_URL=http://127.0.0.1:8080 SMOKE_LOAD=1 node smoke/smoke.mjs   # red
```
