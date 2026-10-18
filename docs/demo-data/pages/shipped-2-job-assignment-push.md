---
id: shipped-2-job-assignment-push
title: #2 Send a push notification when a job is assigned
parent: shipped
order: 2
---
# #2 Send a push notification when a job is assigned

Delivered by Zara Haddad. Pull request: https://example.com/northwind/field-app/pull/44 (merged). Released on the 15 September train.

## Why
Technicians learn about a new job only when they open the app. A push notification gets the job to them within seconds, which is what dispatchers keep asking for.

## Acceptance criteria
- [x] Assigning a job sends one push notification to the assigned technician on iOS and on Android.
- [x] Tapping the notification opens that job.
- [x] A retry after a network error never sends the same notification twice.
- [x] The vendor is called through one module so it can be replaced (see ADR-0002).
- [x] Technicians can switch assignment notifications off in the app settings.

## Notes (tickets/2.md)

## What changed
The server sends a notification when the assignee of a job changes. The notification carries the job id and nothing else; the title and text are filled in on the phone.

## Decisions
The job id and the assignee form the idempotency key, so a retry is a no-op for the vendor.

## Not done
A daily summary notification is out of scope.

*Synthetic demo content: Northwind Field App is a fictional company.*
