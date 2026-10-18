---
id: adr-0002-push-notification-vendor
title: ADR-0002: Which vendor sends our push notifications
parent: decisions
order: 2
---
# ADR-0002: Which vendor sends our push notifications

Status: accepted on 12 February 2026. Deciders: Ines Carvalho, Owen Whitaker, Zara Haddad.

All vendor names on this page are synthetic.

## Context

When a dispatcher assigns a job, the technician's phone should buzz within seconds. That needs push notifications on both iOS and Android. A missed assignment costs a customer real money, so we also need to know whether a notification was delivered.

## Decision

We use **PushRelay** for push notifications. The app talks to it through one small module on our server, so changing vendor later means changing one file and not the whole app.

## Options considered

| Option | Verdict |
| --- | --- |
| PushRelay | **Chosen.** Reports delivery for each message, has a clear monthly price and a written availability promise. |
| BeaconPing | **Rejected.** It does not give per-message delivery receipts, so we could not tell a technician who missed an assignment from one who got it. |
| Talk to the phone makers' services directly | **Rejected.** Token management, retries and delivery reports would all become our work, and a team of five should not be running that. |

## Consequences

- The monthly price grows with volume. Review it at every renewal.
- If PushRelay is down, assignments are not pushed. The job list still shows them when the technician opens the app.
- The vendor stores device tokens. What it keeps, and for how long, is in the contract summary.

*Synthetic demo content: Northwind Field App is a fictional company.*
