---
id: release-process
title: Release process
parent: engineering
---
# Release process

A release train leaves every second Tuesday. The freeze is the Monday before, at 18:00 Singapore time.

## Rollout

The first rollout step is 5% of users for 24 hours. We halt a rollout when crash-free sessions drop below 99.2%. A sync error rate above 1.5% also halts a rollout.

## Rollback

Rolling back is a decision for the engineer on call. Write down why in the release thread.
