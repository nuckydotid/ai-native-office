---
id: postmortem-2026-09-sync-outage
title: Postmortem: sync outage on 14 September 2026
parent: engineering
order: 3
---
# Postmortem: sync outage on 14 September 2026

Author: Kai Nakamura. Reviewed by Owen Whitaker and Ines Carvalho. This postmortem is blameless: it looks at how the system let this happen, not at who touched it last.

## Summary

On Monday 14 September 2026 the sync gateway rejected every connection for **47 minutes**, from 14:06 to 14:53 Singapore time. The cause was an expired TLS certificate. Nothing warned us before it expired, and we learned about the outage from a customer's phone call.

## Impact

- **312 technicians** with the app open could not upload inspections during the outage.
- No data was lost. The app kept the unsent inspections on the phone and uploaded them once the gateway was back.
- 23 people contacted support. The first call came at 14:19, thirteen minutes after the outage began.

## Timeline

All times are Singapore time on 14 September 2026.

- 14:00 The certificate on the sync gateway expires.
- 14:06 The first connections are rejected.
- 14:19 A customer phones support to say uploads fail. Owen alerts Kai.
- 14:27 Kai sees the TLS errors in the gateway logs.
- 14:34 Kai finds the expiry date and starts issuing a new certificate.
- 14:48 The new certificate is installed.
- 14:53 Connections succeed again. Owen posts the all-clear.

## Root cause

During the migration to the new gateway in August, the job that renews the certificate automatically was switched off so it would not interfere with the cut-over. It was never switched on again. There was no alert on the certificate's expiry date, so nobody noticed that the renewal never happened.

## What went well

- The app kept unsent inspections on the phone, so no work was lost.
- Once Kai was looking at the logs, the cause was clear within minutes.

## What went badly

- We found out from a customer, not from our own monitoring.
- The runbook had no step that said "check the certificate".
- The incident had no named lead, and two people investigated the same thing at first.

## Action items

| Action | Owner | Status |
| --- | --- | --- |
| Switch the automatic renewal job back on | Kai | Done on 15 September |
| Add a certificate check to the incident runbook | Kai | Done on 29 September |
| Alert 21 days before the certificate expires | Kai | Open, ticket #13 |
| Run a synthetic sync check against the gateway every 5 minutes | Unassigned | Proposed, not yet scheduled |

## Lessons

An automatic job that is switched off for a good reason needs a reminder to switch it on again. Any date that can break production should have an alert on it.

*Synthetic demo content: Northwind Field App is a fictional company.*
