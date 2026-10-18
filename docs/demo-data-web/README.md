# The web company seed (in progress)

The workspace the hosted demo is seeded from once the delivery pipeline goes live: a fictional web company, **Northwind Commerce**, shipping
the **Northwind Customer Portal** (orders, invoices, support tickets), with its handbook, runbooks, a standup, 16 tickets spread over the six
pipeline stages (Plan, Design, Build, Test, Release, Deploy) and the ten AI colleagues.

It has the same shape as `docs/demo-data/` (see its README: `team.json`, `tickets.json`, `standup.json`, `pages/*.md`, `agents/*`). The team
server reads whichever folder `DEMO_DATA_DIR` names. Until the cutover that is still `docs/demo-data/` (the mobile-app story, which the
38-case evaluation is written against); `DEMO_SEED=web bash deploy/deploy.sh` points a deploy at this folder instead.

Everything in the demo is synthetic: the company, its people, its vendors and every figure are invented.
