# Changelog

What changed and roughly when, coarser than the records. For *why*, follow the link to the record.

Keep a Changelog conventions, grouped by date until releases exist. There is no release yet.

Entries before 2026-09-13 are **reconstructed** from commit messages and `docs/PLAN/13`; they summarise, and the commits are the authority.

---

## Unreleased

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
