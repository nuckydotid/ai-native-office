---
id: architecture-notes
title: Architecture notes
parent: engineering
---
# Architecture notes

## Background

The app was first written as a single module and has grown. This page records how the main parts fit together and why. It is long on purpose so that it is cut into more than one chunk when it is indexed.

## Sync

Offline edits are stored as an operation log on the device. When the device is online again the log is uploaded in batches of 50 operations. The server applies operations in the order of its own clock, so for two edits to the same field the later server time wins. The operation log is kept for 45 days.

## Storage

Photos are stored in object storage and referenced from the inspection record. Thumbnails are generated on the device from a downscaled copy and released as soon as the screen closes.

## Notifications

Push notifications go through one vendor behind an interface, so the vendor can be replaced without changing the app. Delivery receipts are stored per message.
