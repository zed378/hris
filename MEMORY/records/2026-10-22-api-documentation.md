# P6-18.2 — Every route documented

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Task** | `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` § P6-18 (step 18.2) |
| **Surface** | web |
| **Author** | Agent (Claude Code) |
| **Status** | Completed; 18.3 (docs page behind a superuser and a hashed key, ADR-031) remains |
| **Reconstructed** | No |

## What Changed

`DOCS` in `apps/web/src/lib/openapi.ts` now has an entry for each of the 86 tenant-plane routes that had none, so `apps/web/test/openapi-coverage.test.ts` (P6-18.1, written failing) passes. The new entries are English, per ADR-030. The older Indonesian entries move to English in `P6-24`.

## How

Each summary was written from the route handler's own comment and code, not from its path. Every behavioural claim in a description was then checked against the code. One draft claim was wrong and was corrected before commit: it said the approver may read a leave attachment, but only the requester and holders of `leave.request.read.all` may. `PG-04` is closed.
