# Phase 4 — Leave

**Goal** (`docs/PLAN/12` §6): leave requests, approval, balances, and a calendar — completing a "Basic without payroll" plan.

**State**: delivered, with approval as a single step (`DV-03`) and a row lock rather than an advisory lock (`DV-04`). Two control failures were found and fixed during the build (`docs/PLAN/13` §5 "Two control failures in leave approval"); **neither fix has an automated test** (`P4-08`).

**Phase 4 DoD** (`docs/PLAN/12` §6):

- [x] Submission through approval; balance deducted accurately
- [x] 50 simultaneous approvals against 2 days → exactly 1 succeeds — `docs/PLAN/13` §3
- [x] Balance never negative; every movement has a ledger row
- [x] Team calendar limited to the manager's scope

---

## Delivered

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P4-01 | Leave types and policies; annual, monthly accrual, and anniversary methods | `leave-accrual.test.ts`; `apps/worker/src/leave-accrual.ts` | DONE (retro) — anniversary has a known limit (`DF-02`) |
| P4-02 | Working-day counting from schedules and holidays | `leave.test.ts` | DONE (retro) |
| P4-03 | Submission with approver chosen from permission holders; manager preselected; single-step decision | `leave-approver.test.ts`; `/api/leave/approvers` | DONE (retro) |
| P4-04 | Self-approval refused without exception; approver must hold `leave.request.approve` | `packages/core/src/leave/requests.ts` | DONE (retro) — **untested** (`P4-08`) |
| P4-05 | Balance ledger; row lock with validation after the lock | `packages/core/src/leave/balance.ts` | DONE (retro) |
| P4-06 | Year-start carry-over job, idempotent | `apps/worker/src/leave-carry-over.ts` | DONE (retro) |
| P4-07 | Team calendar within permission scope | `/leave/calendar` | DONE (retro) |
| P4-13 | Leave attachments as files, with orphan cleanup | `packages/core/src/leave/attachments.ts` | DONE (retro) |
| P4-09 | Leave counted in the attendance recap, not as absence | `packages/core/src/attendance/daily.ts` | DONE (retro) |
| P4-10 | Leave decision push notification with deliberately thin content | `apps/worker/src/leave-notify.ts` | DONE (retro) |

---

## Open

### P4-08 — Automated tests for the leave approval controls

| | |
|---|---|
| **Status** | DONE — 2026-10-22 (`apps/web/test/leave-approval-controls.test.ts`) |
| **Priority** | P1 |
| **Depends on** | — |
| **Plan refs** | `docs/PLAN/13` §5 "Two control failures", `docs/SECURITY/02` §5(b)(c), `docs/PLAN/16` §1 |
| **Spec required** | No — coverage of existing behaviour |
| **Surface** | backend |
| **Size** | S |

**Goal** — the two control failures fixed during the build cannot silently return.

**Definition of Done** — integration tests against real PostgreSQL, through the decision route's handler:
- A manager holding `leave.request.approve` requests leave, then approves it → refused; balance unchanged; no approval audit row.
- The same as an HR administrator and as `TENANT_OWNER` → refused ("without exception").
- A request naming an approver who lacks `leave.request.approve` → refused at creation.
- A user other than the named approver who holds the permission may decide (HR standing in).
- Each test seen to fail with the corresponding check commented out.

**Abuse cases to test** — `SECURITY/02` §5(b) self-approval, §5(c) approver without permission.

### P4-11 — Tiered approval

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | A customer who defines who the second approver is (`DF-01`, `docs/PLAN/13` §2.4) |
| **Plan refs** | `docs/PLAN/12` Phase 4 scope |
| **Spec required** | Yes — authorization |
| **Surface** | backend, web, db |
| **Size** | L |

### P4-12 — Anniversary-based balance periods

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | A tenant using `ANNIVERSARY` (`DF-02`) |
| **Plan refs** | `docs/PLAN/13` §5 Leave |
| **Spec required** | Yes — data model |
| **Surface** | db, backend |
| **Size** | L |

Until then, a tenant using `ANNIVERSARY` must set `maxCarryOverDays` to their quota. The leave policy screen should say so — `PF-19`.
