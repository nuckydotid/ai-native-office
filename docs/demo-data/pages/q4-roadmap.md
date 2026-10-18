---
id: q4-roadmap
title: Q4 2026 roadmap
parent:
order: 1
---
# Q4 2026 roadmap

Owner: Owen Whitaker (product). Last updated on 12 October 2026.

Northwind Field App is a mobile app for field service technicians: checklists, photos, signatures and job lists, used on site and often without a signal. This quarter we make the app work properly offline and prove it with our first pilot customer.

## Milestones

| Date | Milestone | Notes |
| --- | --- | --- |
| 2 November 2026 | Harbourline Logistics pilot starts | The first pilot group uses the app with offline sync switched on behind a feature flag. |
| 10 November 2026 | Barcode scanning for equipment tags ships | Goes out on the 10 November release train. Ticket #8. |
| 20 November 2026 | Offline sync is available to all customers | Needs the pilot group to run cleanly first. The design is in ADR-0001. Ticket #7 is the main piece of work. |
| 4 December 2026 | Inspection reports can be exported as PDF | Ticket #12. |
| 11 December 2026 | Shared API keys moved to the secret manager and rotated | Ticket #14. |
| 22 December 2026 | Last release train of the year | No releases between 23 December and the new year. |

## Not in this quarter

- **Dark mode** is not planned for Q4. See the notes of the 6 October planning meeting for why.
- **Vietnamese** ships only after a native speaker has reviewed the checklist wording. There is no date yet.
- Anything that needs a new push vendor. The current vendor's renewal is still to be decided.

## What could move the dates

- **Offline sync.** The conflict rule has two failing test cases. If they point to a design problem and not a bug, the 20 November date moves.
- **The pilot.** The pilot needs the customer's technicians to be trained in the first week. Delays on their side move the whole pilot.
- **Vendor renewal.** The push vendor contract renews automatically unless we give notice. Ines decides, and Owen prepares the numbers.

## How we decide what goes on this page

A milestone is on this page only if it has a ticket and an owner. Wishes and ideas stay on the Plan page until somebody takes them. When a date changes, Owen updates this page the same day and says so in the lobby.

*Synthetic demo content: Northwind Field App is a fictional company.*
