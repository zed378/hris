# 17 — Security Baseline

The controls that exist, where each is enforced, and the gaps. This is the summary; the reasoning about attackers and scenarios is in `docs/SECURITY/`, starting at `SECURITY/00-ASSET-AND-TRUST-BOUNDARY-INVENTORY.md`.

Written 2026-09-13 against the code. A control listed here was verified to exist on that date; "enforced by" names the place a reader can check it.

---

## 1. Tenant Isolation

| Control | Enforced by |
|---|---|
| RLS enabled **and forced** on every table with `tenant_id` | Migrations; `packages/db/test/rls-coverage.test.ts` |
| Fail-closed tenant context: no context → zero rows | `public.app_current_tenant()` |
| Tenant context set per transaction, bound as a parameter | `withTenant()` in `packages/db/src/tenant-context.ts`; the injection test in `tenant-isolation.test.ts` |
| Runtime roles are `NOBYPASSRLS` and are not table owners; every deploy re-asserts `NOBYPASSRLS` | `20260818033000_rls_and_guards`, `20260901150000_auth_role` (risk R21) |
| Domain code cannot import Prisma directly | `no-restricted-imports` in `eslint.config.js` |
| A document's employee must belong to the same tenant, **at the database**, because foreign keys are checked without RLS | Composite FK `(tenant_id, employee_id)` in `20260901120000_employee_documents_fk` |
| `X-Tenant-ID` confirms the token, never replaces it | `define-route.ts`; `TENANT_MISMATCH` test in `gateway.test.ts` |
| `LISTEN`/`NOTIFY` channels are per tenant, because they sit outside RLS | `packages/db/src/live-events.ts` |
| Daily detection of a tenant table without RLS, or RLS without a policy | `public.schema_drift_report()`; worker job |

## 2. Authentication

| Control | Enforced by |
|---|---|
| Argon2id password hashing | `packages/core/src/auth/password.ts` |
| An unknown tenant costs the same time as a wrong password | `burnTimingBudget` in `login.ts` |
| Account lockout after 8 failures for 15 minutes, with `retry-after` | `ACCOUNT_LOCKED`, `login.ts` — no automated test |
| Refresh tokens: random, stored hashed, rotated on use, reuse treated as theft | `tokens.ts`, `TOKEN_REUSE_DETECTED` |
| Refresh token only in an `HttpOnly`, `SameSite=Strict`, `Path=/api/auth` cookie | `session-cookie.ts`, `apps/auth/src/http.ts` |
| Access token in memory only, 15-minute TTL | `apps/web/src/lib/session.tsx` |
| Password reset and invitation tokens stored hashed, single use | `action-tokens.ts` |
| "Forgot password" answers `204` whether or not the address exists | route handlers in both planes |
| Asymmetric signing (EdDSA) with `kid` and a public JWKS | `signing-keys.ts`, `jwt.ts` |
| The algorithm is taken from the key, never from the token | `verifyJwt`; `alg: none` and HS256-with-public-key tests |
| Tenant and control-plane tokens use separate key realms | `JWT_*` / `ADMIN_JWT_*` |
| A permission change invalidates outstanding tokens | Access version `av`, compared on every request |

## 3. Authorization

| Control | Enforced by |
|---|---|
| No unregistered route (P7) | `ROUTE_MANIFEST`, load-time throw |
| Subscription beats role (P8) | `decideAccess`, `402` before `403` |
| DENY grants beat roles | `resolveEffectiveAccess` |
| Expired grants ignored, not deleted | `resolveEffectiveAccess` |
| A requester cannot approve their own leave, without exception | `packages/core/src/leave/requests.ts` — no automated test |
| A leave approver must actually hold the approval permission | `createRequest` |
| The gateway authorizes through one function only | `decideAccess`; a lint rule forbids `resolveEffectiveAccess` in `apps/web` |
| Permission cache cannot outlive a revocation | Version in the cache key; tenant generation bumped on entitlement change |

## 4. The Control Plane (P11)

| Control | Enforced by |
|---|---|
| Separate audience (`hrms-admin`), separate key realm, 8-hour sessions | `superuser-auth.ts` |
| TOTP mandatory for superusers, enforced by a database constraint | `platform.superusers` |
| `hrms_platform` has no grant on `auth.users`, `iam.*`, or `audit.*` | `rls-coverage.test.ts` |
| Superuser tenant status and plan changes go to a separate platform audit trail (logins are not recorded) | `platform.platform_audit_logs` |

## 5. Personal Data

| Control | Enforced by |
|---|---|
| National ID, tax ID, and bank account encrypted with AES-256-GCM, versioned ciphertext (`v1.`) | `packages/core/src/employee/pii.ts` |
| A key ring: one key encrypts, several may decrypt; rotation procedure rehearsed | `ops/RUNBOOK.md` §8; `pii-rotation.test.ts` |
| Equality lookup through a blind index, never through plaintext | `nationalIdIndex` |
| Masked by default; unmasking requires `employee.pii.unmask` | Employee list, detail, and export endpoints |
| An export records whether it was unmasked | `employee.exported` audit row, `packages/core/src/employee/export.ts` |
| Plaintext PII never stored in the import staging table | Import pipeline (`13` §4) |
| Logs redact national IDs, bank accounts, passwords, and bearer tokens | `packages/observability/src/logger.ts`; `logger.test.ts` |
| The portability export omits ciphertext and password hashes | `packages/core/src/tenant/data-export.ts` |

## 6. Attendance Evidence (P14, P15)

| Control | Enforced by |
|---|---|
| Evidence is scored, never auto-rejected on one signal | `trust.ts`; the HR review queue |
| EXIF (including GPS) stripped from every photo | `photo.ts` |
| Photos deleted after the tenant's retention period; attendance rows survive | Worker retention job |
| HR access to photos and documents is logged | `photo_access_logs` |
| Withdrawing location consent is honoured by the server and not penalised | `consent.ts`, `trust.ts` |
| The live dashboard payload carries no coordinates | `live-events.ts` |
| Browser punches carry a `WEB_UNVERIFIED_DEVICE` penalty, since mock GPS is undetectable (R47) | `trust.ts` |

## 7. Files and Input

| Control | Enforced by |
|---|---|
| Uploaded file type decided from magic bytes, not name or `content-type` | `packages/core/src/employee/documents.ts` |
| Documents archived rather than deleted | Documents module |
| Salary formulas parsed against an allowlist — no `eval` | `packages/core/src/payroll/formula.ts` |
| Every request body validated with `zod` before use | Route handlers |
| Raw SQL only through tagged templates (`$queryRaw`), which bind parameters | Convention; no string-concatenated SQL found |

## 8. Operational

| Control | Enforced by |
|---|---|
| Per-route rate limits on guessable public paths, shared across replicas via Redis | `ROUTE_MANIFEST` `rateLimit`; `packages/cache` |
| Per-tenant quota of 600 requests/minute | `consumeTenantQuota` |
| `statement_timeout` per role: app 15 s, worker 5 min, platform 30 s | Migration `statement_timeout` |
| The service worker never caches API, admin, credential pages, or `Authorization`-bearing requests | `apps/web/public/sw.js`; `service-worker.test.ts` |
| Metrics exposed only with a token, never labelled by tenant | `packages/observability/src/metrics.ts` |
| OpenAPI document behind an administrator's permission — moving behind a superuser session and a hashed docs key (ADR-031, `P6-18.3`) | `GET /api/openapi.json` |
| Append-only audit logs: `UPDATE`/`DELETE` revoked and blocked by trigger | `audit.audit_logs` |

## 9. Gaps

Controls a reader might reasonably assume exist, and which do not. Each is tracked in `TASKS/BACKLOG.md`.

| Gap | Consequence | Severity |
|---|---|---|
| **The client address is the first `X-Forwarded-For` entry, which the client controls** | Per-address rate limits and office-network verification can be bypassed | **High** |
| No `Content-Security-Policy`, `Strict-Transport-Security`, or frame-ancestors headers | XSS impact is not contained by the browser | High |
| No MFA for tenant users — only superusers have TOTP | One leaked password opens a tenant's HR data (R18); `12` Phase 5 DoD item unmet | High |
| `JWT_SECRET` still configured, so HS256 tokens still verify | Anything holding the secret can still mint tokens | Medium |
| **Viewing unmasked PII in the employee list or detail is not audited** — only exports are | An HR insider can read every national ID with no trace; `12` Phase 2 DoD requires unmasking to be audited | High |
| Superuser TOTP secrets stored in plaintext | A database read defeats the control plane's second factor | Medium |
| No permission ceiling for role and grant administrators | A holder of `iam.role.manage` or `iam.grant.manage` can confer any permission, including on themselves | Medium |
| `hrms_app` can still read `auth.users` | The backend can read credential rows it no longer needs (`14` §10.5) | Medium |
| Service-to-service authentication is a shared secret, not mTLS | As strong as the environment holding it — **only relevant if the auth service is enabled, which is not planned** (ADR-032) | Low |
| No CI pipeline, so no dependency or secret scanning runs automatically | A vulnerable dependency or committed secret is not caught | Medium |
| No error tracking (the Sentry named in `12` was never added) and no alerting | Security-relevant errors are visible only in logs someone reads | Medium |
