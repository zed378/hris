# P6-24 — English Backend Messages With Machine-Readable Reasons

Status: **Implemented** — 2026-10-22
Task: `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` P6-24
Plan refs: `docs/PLAN/15` §6 and §11, `docs/UI-UX/13` §1, `docs/UI-UX/04`, ADR-030, ADR-034, ADR-037, ADR-040

## 1. Business Objective
Users read Indonesian that the frontend chooses. To do that, the frontend has to know *which* refusal it got. The backend speaks English for developers. Done when backend messages are English, every refusal in the `docs/UI-UX/04` flows carries a reason, and emails and push are Indonesian.

## 2. Actors
Every user who meets a refusal; developers reading logs; the frontend (`PF-20`).

## 3. Functional Requirements
- **FR1** The error envelope gains an optional `error.reason` from `ErrorReason` in `packages/contracts`. `code` is unchanged.
- **FR2** Reason parameters travel in `details`, as string arrays: `missing`, `maxBytes`, `available`, `requested`, `minServiceMonths`, `serviceMonths`, `period`, `field`.
- **FR3** Reasons for the UI-UX/04 flows:

  | Flow | Reasons |
  |---|---|
  | 2 and 10, links | `ACTION_TOKEN_INVALID` |
  | 3, import | `FILE_MISSING`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ACCEPTED` |
  | 4, punch | `PUNCH_EVIDENCE_REQUIRED`, `PUNCH_EVIDENCE_REQUIRED_OFF_NETWORK`, `ATTENDANCE_PERIOD_CLOSED`, `PUNCH_DUPLICATE`, `ACCOUNT_NOT_LINKED` |
  | 7, request leave | `LEAVE_INVALID_RANGE`, `LEAVE_ATTACHMENT_REQUIRED`, `LEAVE_ATTACHMENT_IN_USE`, `LEAVE_NOT_ENTITLED`, `LEAVE_NO_WORKING_DAYS`, `LEAVE_INSUFFICIENT_BALANCE`, `LEAVE_OVERLAP`, `LEAVE_APPROVER_NOT_ELIGIBLE` |
  | 8, approve leave | `LEAVE_SELF_APPROVAL`, `LEAVE_ALREADY_DECIDED` |

  Plus `DUPLICATE_VALUE`, with `details.field`, for unique codes.
- **FR4** Login failures carry no reason (`SECURITY/02` §12).
- **FR5** All other backend string literals are English. Exceptions:
  - emails and push (ADR-034);
  - seeded display data (ADR-030);
  - generated documents and stored identifiers (ADR-040).

  The ADR-040 exceptions are marked in place with `// lang: id — <reason>`.
- **FR6** The audit API returns `actor.kind` (`user`, `deleted`, `system`) rather than made-up display names.

## 4–6. Non-functional requirements, dependencies, database
None. No migration.

## 7. API Contract
Additive: `error.reason` is optional. Messages change language. Clients that branched on message text break by design. The frontend renders messages until `PF-20` maps codes and reasons, so for that window users see English. `PF-20` is next.

## 8. Frontend Changes
The audit page renders `actor.kind`. The catalogue is `PF-20`.

## 9. Backend Changes
- `packages/contracts/src/errors.ts`: `ErrorReason`.
- Route helpers: `apiError` and the auth service's `fail` take a `reason`.
- `LeaveError` and `PunchError` carry `reason` and `details`.
- `lib/leave-error.ts` and `lib/punch-error.ts` map them.
- `packages/core/test/backend-english.test.ts` guards the language.
- `notification-language.test.ts` and `leave-push-language.test.ts` pin the Indonesian outputs.

## 10–13. Authorization, validation, error handling, edge cases
Unchanged behaviour. Statuses and codes are unchanged except where corrected earlier (P4-08).

## 14–16. Abuse cases, logging, controls
No information added to refusals that `SECURITY/02` §12 withholds.

## 17. Testing Strategy
- The backend-language guard, which uses the TypeScript parser: every string literal and template part, comments excluded. It was seen to fail when a literal was added.
- The email test against the old English templates: 7 of 7 failed.
- The leave-control tests assert `reason`.
- Tests that asserted Indonesian prose were moved to English, or to kinds where they exist.

## 18–22. Acceptance, DoD, sequence, rollback, risks
Risk: the guard is a word list and cannot prove absence. It went through three widenings, each of which found leftovers (357, then 23, then 37 literals). Rollback is a revert.
