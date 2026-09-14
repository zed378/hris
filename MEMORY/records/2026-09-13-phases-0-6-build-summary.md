# Phases 0–6 — Build Summary

| | |
|---|---|
| **Phase** | Phases 0–6 of `docs/PLAN/12` |
| **Started** | 2026-08-18 (first commit `49481e8`) |
| **Completed** | Open — delivered through 2026-09-01; see `TASKS/PROGRESS.md` for what remains |
| **Tasks done** | 68 of the 117 Phase 0–6 tasks (`DONE (retro)`) |
| **Gates** | A untested · B untested · C not met |
| **Release tag** | None |
| **Reconstructed** | **Yes** — written 2026-09-13 from `docs/PLAN/13` (last updated 2026-08-28), commit messages from 2026-08-18 to 2026-09-01, and the code |

---

## A Note on What the History Can Show

The first commit already contained substantial code: authentication, the employee module, attendance, and the PWA arrived in the first five commits on 2026-08-18. The history therefore **cannot** show Phases 0 and 1 being built in order, and this summary does not pretend it can. It groups what exists by phase, dates what the commits date, and names the source of each claim.

| Date | Commits | What landed |
|---|---|---|
| 2026-08-18 | 12 | Platform, auth, employees, contracts, notifications, attendance, PWA, photos and retention, typed outbox consumers, manual punch, **tenant time zones** |
| 2026-08-28 | 17 | Leave, payroll framework, documents, subscriptions, dashboards, registration and portability, health and readiness, structured logging and backup, accrual, schedules, holidays, suspension, IAM screens, `.xlsx` export, onboarding fixes |
| 2026-08-31 | 53 | Admin console, API-call coverage guard, leave controls fixed, Web Push, attendance policy, monthly recap, **PITR**, English translation of plan and comments (29 commits, one of them repairing comment terminators the translation broke), office networks, tenant FK for documents, PII key rotation, manager resolution, `work_date` backfill job, SSE through nginx, **service split stages 1–8** |
| 2026-09-01 | 7 | Online migration runner, trends, Prometheus metrics, `.kilo` state untracked, the other tool's translation commit, a build fix |

## What Shipped

- **A multi-tenant HR platform** where tenant isolation is enforced by the database, not by remembering a `WHERE` clause.
- **Self-service**: a company registers, starts a trial, invites staff, chooses modules; an operator can suspend it from a control plane that cannot read its employees.
- **Employees**: a list and an Excel-like grid, organisation and employment history, contracts with reminders, documents, encrypted and masked national ID, tax ID, and bank account, and an Excel import that reports errors per row.
- **Attendance**: punching from a phone with location and a selfie, scored rather than trusted, an HR review queue, an offline queue that replays once, shifts, schedules, holidays, attendance machine import, a live dashboard, monthly recaps, and period closing — all in the tenant's own time zone.
- **Leave**: types, accrual, working-day counting from schedules, approval with the manager preselected, a locked balance ledger, carry-over, a team calendar, attachments, and a push notification on decision.
- **Payroll framework**: components with an allowlisted formula language, period-based salary structures, runs calculated in the worker with a per-line trace. **No tax or BPJS.**
- **Operations**: health and readiness, structured redacted logs, metrics behind a token, backups with storage archive, point-in-time recovery, PII key rotation, a schema drift report, and a runbook.

## Definition of Done Verification

Per-phase detail with evidence is in the `TASKS/PHASE-<n>-*.md` headers and `docs/PLAN/21-ACCEPTANCE-CRITERIA.md` §4. In summary:

| Phase | DoD items met | Not met or unverified |
|---|---|---|
| 0 | ADRs (reconstructed); restore tested; PITR | Spikes S1–S4; 30 payroll cases; CI; staging |
| 1 | Tenant, login, sidebar; migration lint; superuser isolation; restore | The three CI gates run only locally |
| 2 | Per-row import errors; masking | **Pilots importing unaided (Gate A)**; unmasking audited on export only; row-for-row export comparison not recorded |
| 3 | Geofence flagging; review queue; EXIF and retention; offline dedupe; no sensitive cache; no tokens in storage | `FALLBACK_ONLY` bypassable (`P3-12`); logout wipe unverified on a device; Lighthouse; real devices |
| 4 | All four | — (but control fixes untested, `P4-08`) |
| 5 | Idempotent runs; framework performance | Parallel run; statutory configuration; MFA; mid-chunk kill |
| 6 | Subscription change reflected; portability | Payment; data-intact-after-disable not tested |

## Gate

| Gate | Condition | State |
|---|---|---|
| A | Three pilots import unaided | **Untested** — `docs/PLAN/13` §1: "both demand real users, not code" |
| B | One paying tenant | **Untested** |
| C | Payroll expert, 30 payslips, S1 30/30 | **Not met** |

Phases 3–6 were built without A and B, and the payroll framework without C. ADR-015, ADR-016, `DV-01`, `DV-02`.

## Performance Results

From `docs/PLAN/18` §2. Development machine unless stated.

| Measurement | Target | Result | Conditions |
|---|---|---|---|
| Punch to live dashboard | < 2 s | 305 ms | One listener |
| SSE through nginx | — | 0.07–0.08 s | Three buffering configurations |
| Concurrent leave approvals | exactly 1 of 50 | exactly 1 | 2-day balance |
| Flood of 700 requests | no 500 | 0 × 500, 372 × 503, 100 × 429 | One process |
| Backup / restore | tested | 2 s / 5 s | 160 MB, 261,000 punches |
| Payroll run | 1,000 in < 3 min | 1,003 in 8.5 s | Framework only, no statutory components |
| p95 API latency under load | < 500 ms | **Not measured** | — |

## Security Verification

Proven against a running server and recorded in `docs/PLAN/13` §3: cross-tenant reads, `TENANT_MISMATCH`, DENY precedence, access version, superuser grant matrix, tenant-aware foreign keys, no sensitive data in Cache Storage.

**Not found during the build, found on 2026-09-13** (`records/2026-09-13-documentation-set.md`): client-controlled `X-Forwarded-For`; unmasked PII views unaudited; no permission ceiling; plaintext superuser TOTP secrets; no security headers.

## Deviations from the Plan

`TASKS/BACKLOG.md` `DV-01` to `DV-14`; ADR-008, 011–016, 025–027.

## Deferred Out of These Phases

Billing, WhatsApp, statutory payroll, tiered leave approval, anniversary balance periods, per-vendor machine connectors, CI, staging, Sentry, uptime check. Each is a task or a `DF-nn` entry.

## Bugs That Failed Silently

`docs/PLAN/13` §4 records 37 defects found by end-to-end testing; nearly all produced no error. The ones that shaped later rules:

| # | Defect | Silent because | Fix recorded in `13` §4 |
|---|---|---|---|
| 1 | Day boundaries in UTC: every morning punch filed on the previous day | Every day was simply `ABSENT` | Tenant time zones (ADR-012) |
| 8 | A masked PII value could be saved as the real value | The grid locked the column, but imports, bulk updates, and the API share the write path | Guard moved to the write boundary (P9) |
| 11 | Formula variable guard bypassable through the prototype chain | Formulas still computed | Prototype-chain cases in `formula.test.ts` |
| 12 | Downgrading a plan did not revoke module access | Only the invoice changed | Entitlement is the intersection of plan and module status |
| 18 | The manifest check was blind to `export function GET()` | The route worked by hand, unchecked | ADR-020 |
| 19 | The `LEAVE` status was never produced; approved leave counted as absence | Pay docked without an error | The status is now produced — and the class ("declared but never produced") recurred four more times |
| 26 | National ID, tax ID, and bank account in plaintext in import staging | Import worked | No plaintext PII in staging; `import-pii.test.ts` |
| 30 | Weekends recorded as `ABSENT`, then deducted from salary | Recap looked complete | Attendance and leave share one working-day assumption; a schedule wins where it exists |

## What Was Harder Than Expected

Not recorded contemporaneously. The commit history shows repeated "a value that can be chosen and produces nothing" defects (`LEAVE`, `MANUAL`, `DISCARDED`, accrual methods, `FALLBACK_ONLY`) — each found by walking a real flow rather than by a failing test.

## What Was Easier Than Expected

Not recorded.

## Risks

Re-assessed in `docs/PLAN/22-RISK-REGISTER.md` on 2026-09-13, including `12` §10.3 N4 and N5, which the build made live.

## Readiness for What Comes Next

Not ready for pilots until `P3-12`, `P0-09`, `P2-08`, `P6-12`, `PF-02`, and `PF-04` are done and staging exists (`P0-10`). `TASKS/PROGRESS.md` Next Up.
