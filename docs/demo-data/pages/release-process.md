---
id: release-process
title: Release process
parent: engineering
order: 1
---
# Release process

Owner: Owen Whitaker (product). Last reviewed on 5 October 2026.

We ship the mobile app to the app stores on a fixed schedule, so customers and the team can plan around it. Small, regular releases are easier to test and easier to undo than large ones.

## The release train

A release leaves every second Tuesday. The trains from now to the end of 2026 are 13 October, 27 October, 10 November, 24 November, 8 December and 22 December.

The **code freeze** is on the Monday before the train, at **18:00 Singapore time**. After the freeze only fixes for problems found while testing the release candidate may go in, and only with the release owner's agreement.

## The release owner

One person owns each train. The role rotates between Kai, Leo, Zara and Owen in that order, and the rota is in the shared calendar. The release owner:

1. Cuts the release candidate at the freeze and builds it for both platforms.
2. Runs the smoke test on one iPhone and on the oldest Android phone we support.
3. Writes the release notes and posts them in the lobby on Monday evening.
4. Starts the staged rollout on Tuesday and watches it.

## Checklist before the freeze

- The test run on the main branch is green.
- Every pull request in the release has two approvals and a ticket whose notes are up to date.
- The version number and the changelog are updated.
- Features that are not ready are behind a server-side flag, switched off.

## Staged rollout

Each release goes out in three steps so a problem hurts few people:

1. **5% of users** for 24 hours.
2. **25% of users** for another 24 hours.
3. **100% of users**.

The release owner checks the crash and sync dashboards at the start and end of every step.

## When to stop

Halt the rollout at once if **crash-free sessions drop below 99.2%**, or if the sync error rate rises above 1.5% of sync attempts. Halting does not remove the release from users who already have it. To undo a feature, switch its server-side flag off. To fix a crash, release a patch: the release owner calls it in the lobby and the next train can leave early.

## After the release

Close the tickets that shipped. Merged tickets get a page under Shipped automatically. If anything went wrong, write down what happened the same day, even if it took five minutes to fix.

*Synthetic demo content: Northwind Field App is a fictional company.*
