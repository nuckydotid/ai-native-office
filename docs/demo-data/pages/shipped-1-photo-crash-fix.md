---
id: shipped-1-photo-crash-fix
title: #1 Fix crash when attaching more than 10 photos to an inspection
parent: shipped
order: 1
---
# #1 Fix crash when attaching more than 10 photos to an inspection

Delivered by Kai Nakamura. Pull request: https://example.com/northwind/field-app/pull/41 (merged). Released on the 15 September train.

## Problem
The app closes without warning when a technician adds the 11th photo to an inspection on a phone with 3 GB of memory. Two customers reported it in September.

## Acceptance criteria
- [x] Adding photos up to the app's limit does not crash on the two lowest-memory test phones.
- [x] Thumbnails are made at a reduced size and released when the screen closes.
- [x] Memory use stays flat while photos are added, checked with the profiler on one iPhone and one Android phone.
- [x] A regression test adds 12 photos in a row.

## Notes (tickets/1.md)

## What changed
Photos were decoded at full size to make thumbnails. Thumbnails are now made from a downscaled copy and the full image is released straight away.

## How it was checked
Profiler run on one iPhone and one Android phone; memory stayed flat. The regression test is in the pull request.

## Follow-ups
Retrying failed uploads is a separate ticket (#5).

*Synthetic demo content: Northwind Field App is a fictional company.*
