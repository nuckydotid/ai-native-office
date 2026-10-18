---
id: on-call-and-incident-runbook
title: On-call and incident runbook
parent: engineering
order: 2
---
# On-call and incident runbook

Owner: Kai Nakamura. Last reviewed on 29 September 2026, after the September sync outage.

## Who is on call

One engineer is the primary on-call for a week at a time. The role hands over on Monday at 10:00 Singapore time and the rota is in the shared calendar. The backup is the next person on the rota. Owen and Ines are the last step of escalation.

The paging tool holds everyone's contact details. They are deliberately not written on this page.

## Severity levels

| Level | What it means | Example |
| --- | --- | --- |
| SEV1 | Sync or sign-in is down for many customers, or customer data is at risk | The sync gateway is unreachable |
| SEV2 | A major feature is broken, but there is a workaround | Photo uploads fail for some phones |
| SEV3 | A minor problem that can wait for the next release | A label is cut off on a small screen |

## Response targets

- **SEV1:** the on-call acknowledges the page **within 10 minutes**. If nobody acknowledges, the page goes to the backup and then to Owen and Ines.
- **SEV2:** acknowledge within 30 minutes during core hours; the next morning outside them.
- **Status page:** post the first update **within 20 minutes** of declaring a SEV1 or SEV2, then every 30 minutes until it is resolved.

## First steps

1. Acknowledge the page, and say in the lobby that you are looking at it.
2. Declare the severity. When unsure, go one level higher; you can lower it later.
3. Name an incident lead, someone to post updates and someone to take notes. In a small team one person may hold two roles, but the lead never writes the updates.
4. **Mitigate before you diagnose.** Roll back, switch a flag off or restart. A quick fix that buys time beats a perfect fix that takes an hour.
5. When the incident is over, end the room session so the minutes are written down while people still remember.

## Checks for the sync gateway

If sync is failing, check in this order:

1. The gateway certificate: has it expired, and did the renewal job run?
2. Whether the gateway answers at all.
3. The size of the upload queue and the error rate by app version.
4. Anything that changed in the last day: a deploy, a flag, a configuration change.

## After the incident

- Write a blameless postmortem and share it within **5 business days**. The September sync outage is the model to copy.
- Every action item gets a ticket with an owner before the postmortem is closed.
- Update this runbook if a step was missing or wrong.

*Synthetic demo content: Northwind Field App is a fictional company.*
