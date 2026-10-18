---
id: adr-0001-offline-sync
title: ADR-0001: How the app syncs offline work
parent: decisions
order: 1
---
# ADR-0001: How the app syncs offline work

Status: accepted on 22 July 2026. Deciders: Ines Carvalho, Owen Whitaker, Kai Nakamura.

## Context

Technicians work in basements, plant rooms and rural sites with no signal. Today the app needs a connection to create or edit an inspection. Customers have told us this is the reason they still carry paper. We need the app to keep working offline and to merge the work safely when the phone reconnects.

Two technicians may edit the same job, and one phone may be offline for a whole shift, so the design has to handle conflicting edits without losing work.

## Decision

1. Every phone keeps a local SQLite database of the jobs it needs.
2. Each change a technician makes is written as an **operation** in a local queue, in the order it happened.
3. When the phone reconnects, it uploads the queue in **batches of 50 operations**. The server applies them in order and keeps an operation log for 45 days.
4. If two operations change the same field of the same record, the rule is **last writer wins per field**, and the order of writes is decided by the **server's clock**, not the phone's. A phone with a wrong clock cannot overwrite newer work.
5. Photos and signatures are append-only. They are added to an inspection and never edited, so they cannot conflict.

## Options considered

| Option | Why not |
| --- | --- |
| A CRDT library such as Automerge | Adds a large library to the app and a data model the team of five would have to learn and debug. Its guarantees are more than inspections need. |
| Last write wins for the whole record | Simple, but one technician's save would wipe out another technician's edits to different fields of the same job. |
| Block editing while offline | This is the problem we are solving. |

## Consequences

- Edits to the same field from two phones resolve silently. The loser sees a "changed by someone else" line in the inspection's activity history, so nothing disappears without a trace.
- The server needs an operation log and a version number on every operation type, so old app versions can still sync after a schema change.
- Tests must cover clock skew, duplicate uploads and a phone that stays offline for days.

*Synthetic demo content: Northwind Field App is a fictional company.*
