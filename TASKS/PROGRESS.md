# Progress Board

The single status board. Updated in the same commit as the work it describes (`00-TASK-CONVENTIONS.md` §4 item 12).

**Last updated**: 2026-10-22 — `P6-13` DONE (permission ceiling; ADR-035)
**Overall**: 78 / 152 tasks done — 77 of them delivered before this board existed (`DONE (retro)`), 1 since
**Gates**: A untested · B untested · C not met · D not reached

> **Read this first.** Phases 0–6 and service-split stages 1–7 were built between 2026-08-18 and 2026-09-01, before
> `TASKS/` existed. Their `DONE (retro)` rows record what the code and `docs/PLAN/13` show, with evidence — not
> task-by-task history. The open work is dominated by three things: **proof** the plan required and the build skipped
> (spikes, pilots, devices, CI), **security findings** from 2026-09-13, and **frontend usability on phones**.

Statuses: `TODO` · `BLOCKED` · `SPEC` · `WIP` · `REVIEW` · `DONE` · `DONE (retro)` · `DROPPED`
Priority: `P0` next · `P1` before pilots · `P2` before paid GA · `P3` when convenient

---

## Next Up

In order. Each is unblocked today.

| # | ID | Task | Why now |
|---|---|---|---|
| 1 | `P3-12` | Take the client address from the trusted proxy | Open vulnerability (F1): office-network verification and rate limits bypassable |
| 2 | `P0-09` | CI pipeline | Every "CI gate" is currently local; no dependency or secret scanning (F2) |
| 3 | `P2-08` | Audit unmasked PII reads | Phase 2 DoD item unmet; HR can reveal every NIK without trace (F11) |
| 4 | `P6-12` | Browser security headers | No CSP or HSTS (F5) |
| 5 | `P6-18.1` | OpenAPI coverage test | A comment claims a test that does not exist; 86 routes undocumented. `P6-18.3` design is now decided |
| 6 | `PF-01` | Extract UI components | Precondition for the frontend track |
| 7 | `PF-02` | Mobile navigation | Employees on phones are stranded (F6); release gate R1 |
| 8 | `PF-20` | Indonesian message catalogue in the frontend | Decided 2026-09-14: users must not read the backend's English messages |
| 9 | `PF-04` | Refused state for 402/403 | Release gate R2 |
| 10 | `P6-24` | English backend messages with reasons | Decided 2026-09-14; `PF-20` needs the reason list |
| 11 | `P4-08` | Tests for leave approval controls | Two fixed control failures have no regression test |
| 12 | `P6-20` | Tests for lockout and login timing | Authentication controls without tests |

---

## Phase Summary

| Phase | Tasks | Done | Status |
|---|---|---|---|
| [0 — Foundation and Proof](./PHASE-0-FOUNDATION.md) | 14 | 6 | **Open** — spikes, discovery, CI, staging never done |
| [1 — Core Platform](./PHASE-1-CORE-PLATFORM.md) | 18 | 15 | Delivered; CI gates local only; no error tracking or uptime check |
| [2 — Employees](./PHASE-2-EMPLOYEES.md) | 10 | 7 | Delivered; **Gate A untested**; unmask audit missing |
| [3 — Attendance and PWA](./PHASE-3-ATTENDANCE-PWA.md) | 19 | 12 | Delivered; **XFF defect**; devices and Lighthouse unverified; **Gate B untested** |
| [4 — Leave](./PHASE-4-LEAVE.md) | 13 | 10 | Delivered; control tests missing |
| [5 — Payroll](./PHASE-5-PAYROLL.md) | 20 | 8 | Framework delivered; **statutory work blocked by Gate C** |
| [6 — Commercialisation and Hardening](./PHASE-6-COMMERCIALISATION-HARDENING.md) | 24 | 10 | Delivered except billing and WhatsApp; security findings and language work open |
| [S — Service Split](./PHASE-S-SERVICE-SPLIT.md) | 14 | 9 | **Stopped by decision** (ADR-032): auth stays in-process; stages 6–8 wait for SSO |
| [F — Frontend Track](./PHASE-F-FRONTEND.md) | 20 | 0 | **Track** — runs alongside |
| 7+ — Expansion | — | — | Not scheduled; Gate D (`DF-07`) |

---

## Phase 0 — Foundation and Proof

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P0-01 | Monorepo | — | — | DONE (retro) | — |
| P0-02 | Architecture ADRs | — | — | DONE (retro) | reconstructed |
| P0-03 | Local environment | — | — | DONE (retro) | — |
| P0-04 | Backups with storage archive, restore tested | — | — | DONE (retro) | — |
| P0-05 | Point-in-time recovery | — | — | DONE (retro) | — |
| P0-06 | `pnpm verify` | — | — | DONE (retro) | — |
| P0-07 | Interview five HR practitioners | M | P1 | TODO | people |
| P0-08 | Collect real artefacts | M | P1 | TODO | P0-07 |
| P0-09 | CI pipeline | M | **P0** | DONE | — |
| P0-10 | Staging environment | L | P1 | TODO | a host (operator action) |
| P0-11 | Spike S2: import at 5,000 rows | S | P3 | TODO | — |
| P0-12 | Spike S3: 100,000 concurrent transactions | M | P2 | TODO | — |
| P0-13 | Spike S1: PPh 21 TER, 30/30 | L | — | BLOCKED | Gate C |
| P0-14 | Spike S4: real devices, 24 h | M | — | BLOCKED | devices |

## Phase 1 — Core Platform

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P1-01 | RLS forced, fail-closed, `NOBYPASSRLS` | — | — | DONE (retro) | — |
| P1-02 | `withTenant`, Prisma import ban | — | — | DONE (retro) | — |
| P1-03 | Migration lint and online runner | — | — | DONE (retro) | — |
| P1-04 | Append-only audit | — | — | DONE (retro) | — |
| P1-05 | Authentication | — | — | DONE (retro) | — |
| P1-06 | Tenant lifecycle and plans | — | — | DONE (retro) | — |
| P1-07 | IAM | — | — | DONE (retro) | — |
| P1-08 | `ROUTE_MANIFEST` and `decideAccess` | — | — | DONE (retro) | — |
| P1-09 | Bootstrap and app shell | — | — | DONE (retro) | — |
| P1-10 | Outbox and consumers | — | — | DONE (retro) | — |
| P1-11 | Control plane | — | — | DONE (retro) | — |
| P1-12 | Module boundaries by lint | — | — | DONE (retro) | — |
| P1-13 | Structured logging | — | — | DONE (retro) | — |
| P1-14 | Health and readiness | — | — | DONE (retro) | — |
| P1-15 | Composite tenant FK for documents | — | — | DONE (retro) | — |
| P1-16 | Error tracking | M | P1 | BLOCKED | `OQ-09` |
| P1-17 | Uptime check | S | P2 | TODO | P0-10 |
| P1-18 | Make Phase 1 CI gates real | S | P1 | TODO | — (branch protection is an operator action in GitHub settings, not code) |

## Phase 2 — Employees

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P2-01 | Employee CRUD and grid | — | — | DONE (retro) | — |
| P2-02 | Organisation and employment | — | — | DONE (retro) | — |
| P2-03 | Contracts and reminders | — | — | DONE (retro) | — |
| P2-04 | Employee documents | — | — | DONE (retro) | — |
| P2-05 | PII encryption and rotation | — | — | DONE (retro) | — |
| P2-06 | Excel import | — | — | DONE (retro) | — |
| P2-07 | `.xlsx` export | — | — | DONE (retro) | — |
| P2-08 | Audit unmasked PII reads | M | **P0** | TODO | — |
| P2-09 | Gate A: three pilots | L | P1 | BLOCKED | pilots; P0-10 |
| P2-10 | Document retention deletion | M | P3 | BLOCKED | `OQ-07` |

## Phase 3 — Attendance and PWA

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P3-01 | Shifts, schedules, holidays | — | — | DONE (retro) | — |
| P3-02 | Punch sources | — | — | DONE (retro) | — |
| P3-03 | PWA and service worker | — | — | DONE (retro) | — |
| P3-04 | Offline queue | — | — | DONE (retro) | — |
| P3-05 | Evidence and photo pipeline | — | — | DONE (retro) | — |
| P3-06 | Trust scoring and review queue | — | — | DONE (retro) | — |
| P3-07 | Consent | — | — | DONE (retro) | — |
| P3-08 | Daily calculation and period close | — | — | DONE (retro) | — |
| P3-09 | Live dashboard | — | — | DONE (retro) | — |
| P3-10 | Tenant time zones | — | — | DONE (retro) | — |
| P3-11 | Office network verification | — | — | DONE (retro) | defect: P3-12 |
| P3-12 | Trusted client address | M | **P0** | DONE | — |
| P3-13 | Run `work_date` backfill | S | P1 | TODO | — |
| P3-14 | Lighthouse on pocket pages | S | P1 | TODO | — |
| P3-15 | Chromium, WebKit, two devices | M | P1 | BLOCKED | devices |
| P3-16 | Logout wipe on a shared device | S | P1 | BLOCKED | device |
| P3-17 | Calibrate flagged-ratio threshold | S | P3 | BLOCKED | pilot data |
| P3-18 | `checkOfficeNetwork` against PostgreSQL | S | P1 | TODO | — |
| P3-19 | Review queue partial index | — | — | DONE (retro) | — |

## Phase 4 — Leave

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P4-01 | Types and accrual | — | — | DONE (retro) | — |
| P4-02 | Working-day counting | — | — | DONE (retro) | — |
| P4-03 | Submission and approval | — | — | DONE (retro) | — |
| P4-04 | Self-approval and approver checks | — | — | DONE (retro) | untested: P4-08 |
| P4-05 | Ledger and row lock | — | — | DONE (retro) | — |
| P4-06 | Carry-over job | — | — | DONE (retro) | — |
| P4-07 | Team calendar | — | — | DONE (retro) | — |
| P4-08 | Tests for approval controls | S | P1 | TODO | — |
| P4-09 | Leave in attendance recap | — | — | DONE (retro) | — |
| P4-10 | Leave decision push | — | — | DONE (retro) | — |
| P4-11 | Tiered approval | L | P3 | BLOCKED | `DF-01` |
| P4-12 | Anniversary balance periods | L | P3 | BLOCKED | `DF-02` |
| P4-13 | Leave attachments | — | — | DONE (retro) | — |

## Phase 5 — Payroll

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P5-01 | Salary components | — | — | DONE (retro) | — |
| P5-02 | Formula parser | — | — | DONE (retro) | — |
| P5-03 | Salary structures | — | — | DONE (retro) | — |
| P5-04 | Runs in the worker | — | — | DONE (retro) | — |
| P5-05 | Calculation trace | — | — | DONE (retro) | — |
| P5-06 | `run_type` schema | — | — | DONE (retro) | schema only |
| P5-07 | Employee payslip list | — | — | DONE (retro) | — |
| P5-08 | `statutory_configs` table | — | — | DONE (retro) | unused |
| P5-09 | PPh 21 TER | XL | — | BLOCKED | Gate C |
| P5-10 | BPJS | L | — | BLOCKED | Gate C |
| P5-11 | Golden regression | M | — | BLOCKED | Gate C |
| P5-12 | Proration and overtime | L | — | BLOCKED | Gate C |
| P5-13 | Parallel run | L | — | BLOCKED | Gate C |
| P5-14 | THR | M | — | BLOCKED | Gate C |
| P5-15 | Tenant-user MFA | L | P1 | TODO | — |
| P5-16 | Payslip isolation tests | S | P2 | TODO | — |
| P5-17 | `statutory_configs` endpoint and screen | M | — | BLOCKED | Gate C |
| P5-18 | PDF payslips | M | — | BLOCKED | Gate C |
| P5-19 | Bank export | M | — | BLOCKED | Gate C |
| P5-20 | Payroll property tests | M | — | BLOCKED | Gate C |

## Phase 6 — Commercialisation and Hardening

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| P6-01 | Self-service registration and trial | — | — | DONE (retro) | — |
| P6-02 | Module activation | — | — | DONE (retro) | — |
| P6-03 | Dashboards and trends | — | — | DONE (retro) | — |
| P6-04 | `.xlsx` export everywhere | — | — | DONE (retro) | — |
| P6-05 | Email and Web Push | — | — | DONE (retro) | — |
| P6-06 | Quotas, timeouts, drift, runbook | — | — | DONE (retro) | — |
| P6-07 | Portability export | — | — | DONE (retro) | — |
| P6-08 | Suspension and churn | — | — | DONE (retro) | — |
| P6-09 | Billing | XL | P2 | BLOCKED | payment account |
| P6-10 | WhatsApp | L | P3 | BLOCKED | WhatsApp account |
| P6-11 | Reference-licence credit | M | P3 | BLOCKED | `OQ-13` |
| P6-12 | Browser security headers | M | **P0** | TODO | — |
| P6-13 | Permission ceiling | M | P1 | DONE | — |
| P6-14 | Encrypt superuser TOTP; audit logins | M | P1 | TODO | — |
| P6-15 | Constant-time internal secret | S | P2 | TODO | — |
| P6-16 | First four alerts | M | P1 | BLOCKED | `OQ-06`, `OQ-09` |
| P6-17 | Off-host backups and key escrow | M | P1 | BLOCKED | `OQ-02`, `OQ-12` |
| P6-18 | API documentation (18.1 coverage · 18.2 routes · 18.3 page and secret) | L | P1 | TODO | 18.3: P6-12 |
| P6-19 | Ownership structural test | M | P1 | TODO | — |
| P6-20 | Lockout and timing tests | S | P1 | TODO | — |
| P6-21 | Morning-peak load test | L | P3 | BLOCKED | P0-10 |
| P6-22 | Metrics endpoint | — | — | DONE (retro) | — |
| P6-23 | Generated OpenAPI document | — | — | DONE (retro) | coverage: P6-18 |
| P6-24 | English backend messages with reasons; Indonesian emails and push | L | P1 | TODO | — |

## Phase S — Service Split

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| PS-01 | Stage 1: EdDSA and JWKS | — | — | DONE (retro) | — |
| PS-02 | Stage 2: access version | — | — | DONE (retro) | — |
| PS-03 | Stage 3: Redis rate limits | — | — | DONE (retro) | — |
| PS-04 | Stage 4: authorization boundary | — | — | DONE (retro) | — |
| PS-05 | Stage 5: `hrms_auth` role | — | — | DONE (retro) | — |
| PS-06 | Stage 6: auth service | — | — | DONE (retro) | opt-in |
| PS-07 | Stage 7: broker seam | — | — | DONE (retro) | opt-in |
| PS-08 | End the HS256 window | S | P1 | BLOCKED | `OQ-14` |
| PS-09 | Revoke `hrms_app` on `auth.users` | L | P2 | TODO | — |
| PS-10 | Service identity beyond a shared secret | L | P3 | BLOCKED | `DF-11` (SSO) |
| PS-11 | Stage 8: split builds | L | P3 | BLOCKED | `DF-11` (SSO) |
| PS-12 | Remote authorization cost | M | P3 | BLOCKED | `DF-11` (SSO) |
| PS-13 | Stage 8 precondition enforced | — | — | DONE (retro) | — |
| PS-14 | Versioned permission cache | — | — | DONE (retro) | — |

## Phase F — Frontend Track

| ID | Task | Size | Priority | Status | Depends / blocked |
|---|---|---|---|---|---|
| PF-01 | Extract UI components | M | **P0** | TODO | — |
| PF-02 | Mobile navigation | M | **P0** | TODO | PF-01 |
| PF-03 | Tables that scroll | S | P1 | TODO | PF-01 |
| PF-04 | Refused state for 402/403 | M | **P0** | TODO | PF-01 |
| PF-05 | Offline state beyond punch | S | P2 | TODO | PF-01 |
| PF-06 | Focus, skip link, nav label | S | P1 | TODO | PF-01 |
| PF-07 | Page titles and focus on navigation | S | P1 | TODO | — |
| PF-08 | Announce async outcomes | S | P1 | TODO | — |
| PF-09 | Field-level server errors | M | P1 | TODO | PF-01 |
| PF-10 | Images, contrast, touch targets | S | P2 | TODO | — |
| PF-11 | First-run setup guidance | S | P1 | TODO | PF-01 |
| PF-12 | Tenant time zone in HR views | S | P2 | TODO | — |
| PF-13 | Browser E2E suite | L | P1 | TODO | P0-09 |
| PF-14 | Automated accessibility checks | S | P2 | TODO | PF-13 |
| PF-15 | One error colour | S | P3 | TODO | PF-01 |
| PF-16 | Confirm discard and close | S | P2 | TODO | — |
| PF-17 | Attendance policy page | S | P3 | TODO | — |
| PF-18 | Mobile-friendly pocket pages | M | P1 | TODO | PF-01, PF-02 |
| PF-19 | `ANNIVERSARY` warning | S | P3 | TODO | — |
| PF-20 | Indonesian message catalogue | M | P1 | TODO | PF-01 |
