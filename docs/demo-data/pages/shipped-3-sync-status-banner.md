---
id: shipped-3-sync-status-banner
title: #3 Show a sync status banner on the job list
parent: shipped
order: 3
---
# #3 Show a sync status banner on the job list

Delivered by Leo Brandt. Pull request: https://example.com/northwind/field-app/pull/47 (merged). Released on the 29 September train.

## Why
Technicians cannot tell whether the list in front of them is fresh. A banner should say when the list was last updated, and when the phone has no connection.

## Acceptance criteria
- [x] The banner reads "Updated just now", "Updating" or "No connection, showing the list from <time>".
- [x] The banner does not push the list down when it appears.
- [x] The text is readable in the light and dark system themes and is read out by the screen reader.

## Notes (tickets/3.md)

## What changed
A small banner above the job list, driven by the last successful sync time and the connection state. It overlays the top of the list instead of pushing it.

## How it was checked
Tried with the connection switched off in the middle of a sync, on one iPhone and one Android phone, in both themes.

*Synthetic demo content: Northwind Field App is a fictional company.*
