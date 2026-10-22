# Changelog

What changed and roughly when, coarser than the records. For *why*, follow the link to the record.

Keep a Changelog conventions, grouped by date until releases exist. There is no release yet.

Entries before 2026-09-13 are **reconstructed** from commit messages and `docs/PLAN/13`; they summarise, and the commits are the authority.

---

## Unreleased

### 2026-10-22 — P4-08: Leave approval control tests

**Tests**
- `apps/web/test/leave-approval-controls.test.ts`: self-approval refused as manager, HR administrator, and `TENANT_OWNER`, with balance, status, and audit unchanged; a request addressed to a non-approver refused at creation; the named approver and an HR stand-in may decide. Each test fails with its check disabled.

**Fixed**
- The decision route answered a refused self-approval with 409; it is now 403, as the submit route already answered. The three leave routes share one `LeaveError` mapping (`apps/web/src/lib/leave-error.ts`), and a 403 now carries `PERMISSION_DENIED` instead of `CONFLICT`.

### 2026-10-22 — P6-15: Constant-time internal secret

**Security**
- `/internal/*` on the auth service compared `x-internal-secret` with `!==`. Both checks now go through `internalSecretValid` (`apps/auth/src/http.ts`), which hashes both values before `timingSafeEqual`, so a guess of any length neither throws nor reveals the secret's length.
- `apps/auth/test/service.test.ts`: wrong secrets of the same and of greater length return 404; a structural test holds `server.ts` to the helper (seen to fail before the change).

### 2026-10-22 — PF-02: Mobile navigation

**Added** — ([record](./records/2026-10-22-mobile-navigation.md))
- Below `md`: a bottom bar (Beranda, Absen, Presensi Saya, Cuti, Slip Gaji, Lainnya) and a drawer with the full menu tree, both from `bootstrap.menu`; the tenant name links home. Closes risk F6; release gate R1 met in Chromium.
- `apps/web/test/mobile-menu.test.ts` — reachability of every menu leaf, and a guard against a second menu list in `src/components` or `src/lib`.

### 2026-10-22 — P6-13: Permission ceiling

**Security** — ([record](./records/2026-10-22-permission-ceiling.md), ADR-035)
- Nobody but a `TENANT_OWNER` holder confers a permission they do not hold (role additions, GRANTs, lifting a DENY, invitations) or changes the owner's access. Refused `403 PERMISSION_CEILING`. Closes risk F12.
- `ErrorCode.PERMISSION_CEILING` added to `packages/contracts`.
- IAM routes share one `IamError` mapping; conflicts on the role and grant routes no longer surface as 404.
- `apps/web/test/permission-ceiling.test.ts` — 16 cases through the real handlers; 11 failed before the change.

### 2026-10-21 — P0-09: CI pipeline

**Fixed** — ([record](./records/2026-10-21-ci-pipeline.md))
- GitHub Actions workflow (`.github/workflows/ci.yml`) with four jobs: `verify`, `broker`, `audit`, `images`.
- `verify` runs `pnpm verify` against real PostgreSQL 18 and Redis 8 containers, with throwaway JWT and PII keys.
- `broker` runs the NATS broker suite against a NATS container with JetStream.
- `audit` runs `pnpm audit --audit-level high` and a secret scan with gitleaks (v8.21.1).
- `images` builds the three Docker images (`Dockerfile.web`, `Dockerfile.worker`, `Dockerfile.auth`) without pushing.
- Updated documentation: `docs/PLAN/16-TESTING-STRATEGY.md`, `docs/PLAN/17-SECURITY-BASELINE.md`, `docs/PLAN/22-RISK-REGISTER.md`.
- Updated `TASKS/PROGRESS.md` (P0-09 DONE, P1-18 TODO).

### 2026-09-14 — Open questions answered

**Decided** — ([record](./records/2026-09-14-open-question-answers.md))
- Backend English; frontend fully Indonesian and never showing a server message (ADR-030). New tasks `P6-24` (English backend messages with machine-readable reasons) and `PF-20` (Indonesian message catalogue).
- API documentation behind a platform superuser session and an Argon2id-hashed docs key; the tenant OpenAPI route to be removed (ADR-031). `P6-18.3` unblocked.
- Authorization stays in-process; SSO maybe later; no public API. The service split stops; the auth service and broker stay built and off (ADR-032).

- First-year capacity envelope: 3 tenants, up to 600 employees (ADR-033). The morning-peak load test drops to P3 and loses its question blocker; so does the 5,000-row import spike.

- Emails and push notifications in Indonesian — the one exception to an English backend (ADR-034); restored in `P6-24`.

**Asked**
- `OQ-15`: language of emails and push notifications — answered the same day.
- `OQ-05` rewritten in plainer terms, then answered the same day.

### 2026-09-13 — Documentation set

**Added** — ([record](./records/2026-09-13-documentation-set.md))
- `docs/README.md`, `docs/PLAN/15`–`23`, `docs/SECURITY/00`–`05`, `docs/UI-UX/00`–`14`.
- `TASKS/`: conventions, board (150 tasks, 77 delivered before the board existed), backlog with 14 open questions, 6 plan gaps, 14 deviations, 10 deferrals.
- `MEMORY/`: 29 reconstructed ADRs, templates, 5 records, 2 draft specs.
- `CLAUDE.md`, `AGENTS.md`.

**Found, not fixed** — see the record for all seventeen
- The client address is the first `X-Forwarded-For` entry, which the client controls; in the default topology no proxy sits in front of `web` at all. Office-network verification, `FALLBACK_ONLY`, per-address rate limits, and audit addresses can be forged (`P3-12`).
- Unmasked PII viewed in employee list or detail is not audited (`P2-08`).
- No permission ceiling for role and grant administrators (`P6-13`); superuser TOTP secrets in plaintext (`P6-14`); no security headers (`P6-12`).
- No mobile navigation (`PF-02`); no designed refused state (`PF-04`).

**Changed**
- `PLAN/` moved to `docs/PLAN/`; every reference updated ([record](./records/2026-09-13-docs-plan-move.md)).

**Other tools**
- `5d99226` translated further API error messages in `apps/web` to English ([record](./records/2026-09-13-concurrent-agent-commits.md)); the language question is open (`OQ-01`).

### 2026-09-01

**Added**
- A runner for migrations that cannot run in a transaction (`323fab8`).
- Month-over-month dashboard trends with the flagged-ratio threshold drawn on the chart (`abf7c76`).
- Prometheus metrics behind `METRICS_TOKEN`, never labelled by tenant (`0a6e696`).
- `GET /api/openapi.json` and `apps/web/src/lib/openapi.ts`, from another tool's commit (`a13cfca`).

**Changed**
- API error messages, notifications, and comments translated to English by another tool (`a13cfca`).

**Fixed**
- A duplicate brace from a concurrent edit broke the build; a test that matched translated prose now matches the variable name (`170a8b5`).
- `.kilo/` tool state removed from history's working set (`1068293`).

### 2026-08-31

**Added**
- Admin console for tenant and module management (`8354c2a`); a guard that every screen API call has an endpoint (`a12ae2e`).
- Web Push for leave decisions (`3151472`); tenant-configurable attendance policy (`bf8756e`); monthly attendance recap (`a52b997`).
- Point-in-time recovery with WAL archiving (`c8c0fe5`).
- Office networks per work site, making `FALLBACK_ONLY` real (`8fadeda`).
- PII key rotation: key ring, job, rehearsed procedure (`83976af`).
- `work_date` backfill job (`7919182`); SSE tested behind a real nginx (`caf74c1`).
- Service split stages 1–8 and the permission cache ([record](./records/2026-09-13-service-split-stages-1-7-summary.md)).

**Fixed**
- Leave: self-approval refused; approver overrides recorded (`2fbb7c1`); attachments required where the type demands (`44096b4`); `Employment.managerId` read, fixing the approver list (`ee85b7c`).
- `employee_documents` foreign key made tenant-aware after a cross-tenant insert succeeded (`61f2291`).

**Changed**
- Plan documents, runbook, README, and code comments translated to English (29 commits).

### 2026-08-28

**Added**
- Leave, payroll framework, documents, and subscriptions (`7a54377`); multi-scope dashboards (`258567f`); self-service registration and data portability (`481bb3d`).
- Health and readiness endpoints (`822d043`); structured logging, correlation, storage backup (`c15fc96`, `81649bf`).
- Monthly and anniversary accrual (`2ae1ce5`); schedule generation (`852896f`); document expiry reminders (`f3cabf4`); holiday management and joint-leave deduction (`51489f4`).
- Payroll calculation in the worker as committed batches (`fa47d92`).
- Tenant suspension; payroll paid status (`474a537`); IAM screens and audit read endpoint (`4a8cfaf`); `.xlsx` export for attendance, leave, payroll (`a3082c6`).
- A guard against menu paths and permission codes drifting (`fdfbf8c`).

**Fixed**
- Plaintext PII no longer stored in import staging (`b16a487`).
- Offline queue punches bound to their owner (`2ae1ce5`).
- Onboarding: tenant defaults seeded, bulk invite, unmaterialised balances shown (`a682257`).

### 2026-08-18

**Added**
- Repository with Docker orchestration; platform, authentication, sessions, employee module, notifications, contracts, attendance, PWA, photo capture and retention, typed outbox consumers, manual punch (`49481e8` – `58e348b`).
- Tenant time zones for work-date calculation (`7c3f2d0`).
