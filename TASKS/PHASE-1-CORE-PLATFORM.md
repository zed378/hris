# Phase 1 — Core Platform

**Goal** (`docs/PLAN/12` §6): the platform every module stands on — isolation, migrations, audit, authentication, tenancy, IAM, route authorization, the outbox, and the control plane.

**State**: delivered (`docs/PLAN/13` §1). The DoD's three **CI gates** exist as tests but run only locally, because there is no CI (`P0-09`). Sentry and an uptime check were never added.

**Phase 1 DoD** (`docs/PLAN/12` §6):

- [x] A new tenant can be created; a user logs in; the sidebar renders exactly the active modules
- [~] **CI gate**: tenant A cannot read tenant B, every table — `tenant-isolation.test.ts`, `rls-coverage.test.ts`; **local only**
- [~] **CI gate**: zero routes without a manifest entry — `route-manifest.test.ts`; **local only**
- [~] **CI gate**: module boundaries — `eslint-plugin-boundaries`; **local only**
- [x] Migrations idempotent; the linter blocks forbidden operations — `ops/scripts/lint-migrations.mjs`, `online-migrations.test.ts`
- [x] A superuser is proven unable to read tenant data — `rls-coverage.test.ts` grant matrix
- [x] A restore from backup tested and documented — `ops/RUNBOOK.md` §6

---

## Delivered

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P1-01 | One PostgreSQL, schema per module; RLS enabled **and forced** on every `tenant_id` table; fail-closed `app_current_tenant()`; runtime roles `NOBYPASSRLS`, re-asserted each deploy | `20260818033000_rls_and_guards`; `rls-coverage.test.ts`, `tenant-isolation.test.ts` | DONE (retro) |
| P1-02 | `withTenant()` with bound `set_config`; domain code barred from importing Prisma | `packages/db/src/tenant-context.ts`; `eslint.config.js` | DONE (retro) |
| P1-03 | Additive migration lint; online migration runner for `CONCURRENTLY` | `lint-migrations.mjs`; `run-online-migrations.mjs`; commit `323fab8` | DONE (retro) |
| P1-04 | Append-only `audit.audit_logs` with `writeAudit`; `UPDATE`/`DELETE` revoked and blocked by trigger | `tenant-isolation.test.ts` | DONE (retro) |
| P1-05 | Auth: tenant code + email + password; Argon2id; 15-minute access token; refresh rotation with reuse detection; lockout; password reset; invitations | `packages/core/src/auth/*`; `docs/PLAN/17` §2 | DONE (retro) |
| P1-06 | Tenants, plans, `tenant_modules`, lifecycle TRIAL → ACTIVE → SUSPENDED → CHURNED | `packages/core/src/platform/tenant-admin.ts` | DONE (retro) |
| P1-07 | IAM: roles, permissions, menus, per-user grants and DENY, expiring grants, effective access with versioned cache | `packages/core/src/iam/*`; `authorize.test.ts` | DONE (retro) |
| P1-08 | `ROUTE_MANIFEST`, `defineRoute`, `decideAccess` (stale → 402 → 403) | `route-manifest.test.ts`, `gateway.test.ts` | DONE (retro) |
| P1-09 | `/api/me/bootstrap`, app shell, dynamic sidebar, login, route guard, locked-module page | `apps/web/src/components/app-shell.tsx`; `menu-coverage.test.ts` | DONE (retro) — the locked-module page is unlinked (`PF-04`) |
| P1-10 | pg-boss, `outbox` with correlation id, idempotent consumers | `apps/worker/src/consumers.ts` | DONE (retro) |
| P1-11 | Control plane: `hrms-admin` audience, separate key realm, TOTP mandatory by constraint, `hrms_platform` with no tenant-data grant, platform audit | `superuser-auth.ts`; `rls-coverage.test.ts` | DONE (retro) — TOTP secrets plaintext (`P6-14`) |
| P1-12 | Module boundaries by lint | `eslint-plugin-boundaries` in `eslint.config.js` | DONE (retro) |
| P1-13 | Structured logging with redaction and correlation | `packages/observability`; `logger.test.ts` | DONE (retro) |
| P1-14 | Health and readiness probes, readiness facts | `/api/health`, `/api/ready`; `docs/PLAN/19` §2 | DONE (retro) |
| P1-15 | Composite tenant foreign key for employee documents | `20260901120000_employee_documents_fk`; commit `61f2291` | DONE (retro) |

---

## Open

### P1-16 — Error tracking

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P1 |
| **Depends on** | — |
| **Blocked by** | `OQ-09` (vendor, PII-adjacent data leaving the country) |
| **Plan refs** | `docs/PLAN/12` §6 Phase 1, `docs/PLAN/19` §6, `docs/SECURITY/03` |
| **Spec required** | Yes — error payloads can carry personal data |
| **Surface** | web, worker, auth |
| **Size** | M |

**Goal** — uncaught errors from `web`, `worker`, and `auth` grouped as issues with correlation ids, with the same redaction the logger applies.

**Steps**
1. Decide the vendor with `OQ-09` (self-hosted is acceptable).
2. One integration point per process, wrapping the existing error paths in `define-route.ts`, the worker's consumer runner, and `apps/auth/src/server.ts`.
3. Reuse `packages/observability` redaction on the event payload **before** it leaves the process.
4. Tag with `routeId` and `correlationId`; **never** with tenant, user, or email (`docs/PLAN/19` §3 rule).

**Definition of Done**
- A thrown error in each process appears as an issue with its correlation id.
- A test error carrying an NIK, a bank account, a password, and a bearer token arrives with all four redacted.
- `docs/PLAN/19` §6 updated.

**Abuse cases to test** — `SECURITY/02` §8(b): PII reaching a third party through an error payload.

### P1-17 — Uptime check

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Depends on** | P0-10 |
| **Plan refs** | `docs/PLAN/12` §6 Phase 1 and §11, `docs/PLAN/18` §3 |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | S |

**Goal** — an external probe of `/api/ready` every minute, with history, so the 99.5% availability target can be measured.

**Definition of Done** — probe running against staging, then production; monthly availability readable; a failed probe reaches the alert channel from `OQ-06`.

### P1-18 — Make the Phase 1 CI gates real

| | |
|---|---|
| **Status** | BLOCKED |
| **Depends on** | P0-09 |
| **Plan refs** | `docs/PLAN/12` Phase 1 DoD |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | S |

**Goal** — the isolation, manifest, and boundary checks run as required status checks on `main`.

**Definition of Done** — each of the three shown to block a pull request containing a deliberate violation; the three `[~]` items above ticked.
