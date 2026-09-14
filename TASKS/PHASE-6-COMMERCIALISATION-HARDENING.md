# Phase 6 — Commercialisation and Hardening

**Goal** (`docs/PLAN/12` §6): remove the team from the path to a sale — self-service registration, trial, payment, module activation — and harden the system for paying customers.

**State**: everything except billing and WhatsApp is delivered (`docs/PLAN/13` §5 Commercialisation). This file also holds the **security and operational findings of 2026-09-13** (`docs/SECURITY/`, `docs/PLAN/22` F-risks), because they are hardening work and none of them is gated.

**Phase 6 DoD** (`docs/PLAN/12` §6):

- [ ] Register, try, pay, and enable a module without the team — **payment not built** (`P6-09`)
- [~] Disabling a module hides its menu and refuses its API, data intact — refusal tested; data retention by design, not tested
- [x] A subscription change reflected in the UI within 10 seconds without re-login
- [x] Full tenant export on request (PDP Act portability)

---

## Delivered

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P6-01 | Self-service tenant registration with trial | `/register`, `POST /api/tenants/register` (5/hour per address) | DONE (retro) |
| P6-02 | Module catalogue, activation and deactivation; tenant generation bump invalidates cached access | `/settings/subscription`; `gateway.test.ts` (`402`) | DONE (retro) |
| P6-03 | Dashboards for tenant, team, and self; six-month trends with gaps as gaps | `/`, `/api/dashboard/trends`; `trends.test.ts` | DONE (retro) |
| P6-04 | `.xlsx` export in every module; monthly attendance recap | `docs/PLAN/13` §5 Commercialisation | DONE (retro) |
| P6-05 | Email (Resend, console fallback) and Web Push | `packages/core/src/notification/*` | DONE (retro) |
| P6-06 | Per-tenant quota 600/min; per-role `statement_timeout`; daily schema drift report; incident runbook | `packages/cache/src/rate-limit.ts`; `ops/RUNBOOK.md` | DONE (retro) |
| P6-07 | Tenant data portability export without ciphertext or password hashes | `packages/core/src/tenant/data-export.ts` | DONE (retro) |
| P6-08 | Suspension and churn from the control plane; enforced at login and refresh | `/admin`; `tenant-admin.ts` | DONE (retro) |
| P6-22 | Metrics endpoint behind a token, never labelled by tenant | `/api/metrics`; `metrics.test.ts` | DONE (retro) |
| P6-23 | OpenAPI 3.1 document generated from `ROUTE_MANIFEST`, behind `core.settings.manage` | `apps/web/src/lib/openapi.ts`; commit `a13cfca` | DONE (retro) — 14 of 100 routes documented (`P6-18`) |

---

## Open — Commercial

### P6-09 — Billing

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P2 |
| **Blocked by** | A Midtrans or Xendit account and credentials; Gate B makes it urgent |
| **Plan refs** | `docs/PLAN/12` §6 Phase 6, `docs/PLAN/13` §5 Commercialisation |
| **Spec required** | Yes — money, external integration |
| **Surface** | backend, worker, web, db |
| **Size** | XL — split into subscription model, invoicing, payment webhook, dunning |

**Goal** — monthly and annual subscriptions paid by the tenant, with invoices, dunning, and recovery of failed payments; suspension driven by payment state.

**Abuse cases to test** — a forged or replayed payment webhook; a webhook for another tenant's invoice; an amount mismatch; activating a module by editing the request instead of paying.

### P6-10 — WhatsApp notifications for urgent matters

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P3 |
| **Blocked by** | A WhatsApp Business API account |
| **Plan refs** | `docs/PLAN/12` Phase 6, `docs/PLAN/04` R52, `docs/UI-UX/08` §8 |
| **Spec required** | Yes — external integration, personal data (phone numbers) |
| **Surface** | worker |
| **Size** | L |

### P6-11 — Subscription credit for reference-product licence owners

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | `OQ-13` — commercial terms |
| **Plan refs** | `docs/PLAN/12` Phase 6, `docs/PLAN/04` §13 |
| **Spec required** | Yes — money |
| **Size** | M |

---

## Open — Security Findings

### P6-12 — Browser security headers

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0** |
| **Depends on** | — |
| **Plan refs** | `docs/SECURITY/02` §13, `docs/PLAN/17` §9, risk F5 |
| **Spec required** | No — but test every page after |
| **Surface** | web, ops |
| **Size** | M |

**Goal** — every response from `web` carries a Content Security Policy, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and `frame-ancestors 'none'`, without breaking the PWA, the live stream, photo capture, or AG Grid.

**Steps**
1. Inventory what the pages load: inline styles from Tailwind, AG Grid styles, the service worker, `blob:` URLs from photo capture, `data:` images.
2. Set headers in `next.config` (so they apply without a proxy) using a nonce-based CSP for scripts.
3. Start in `Content-Security-Policy-Report-Only` on staging; collect violations; tighten; switch to enforcing.
4. HSTS only when served over TLS (`COOKIE_SECURE` already signals this).

**Definition of Done**
- A test fetching `/`, `/login`, `/attendance/punch`, and one API route asserts each header is present.
- Every page in `docs/UI-UX/07` loads with zero CSP violations in the console — recorded.
- An injected inline `<script>` in a leave reason does not execute (manual exercise, `docs/SECURITY/05`).
- `docs/PLAN/17` §9, `docs/SECURITY/02` §13, risk F5 updated.

**Abuse cases to test** — `SECURITY/02` §13 stored XSS in a free-text field viewed by HR; clickjacking by framing the approval page.

### P6-13 — Permission ceiling for role and grant administrators

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — |
| **Plan refs** | `docs/SECURITY/02` §5(a), `docs/PLAN/05`, risk F12 |
| **Spec required** | Yes — authorization |
| **Surface** | backend |
| **Size** | M |

**Goal** — nobody can confer a permission they do not themselves hold, through a role or a direct grant; `TENANT_OWNER` remains able to confer anything.

**Steps**
1. Spec: the rule for roles (every permission added must be held by the actor), for grants, for DENY grants (removing access should stay possible), and for editing a role the actor themselves holds.
2. Enforce in `setRolePermissions` and the grant functions in `packages/core/src/iam/administration.ts`, with a distinct error the UI can explain.
3. Consider refusing self-grants outright, audited either way.

**Definition of Done**
- Integration tests: a custom role holding `iam.role.manage` but not `payroll.run.execute` cannot add `payroll.run.execute` to any role, including its own; cannot grant it directly to itself or anyone; can add permissions it holds; `TENANT_OWNER` can add anything.
- Seen to fail against the current code.
- `docs/SECURITY/02` §5, risk F12, `docs/PLAN/05` (amend by ADR if the rule is new policy) updated.

**Abuse cases to test** — `SECURITY/02` §5(a).

### P6-14 — Encrypt superuser TOTP secrets; audit superuser logins

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — |
| **Plan refs** | `docs/SECURITY/02` §9(c), `docs/SECURITY/03` D-8, `docs/PLAN/06`, risk F13 |
| **Spec required** | Yes — authentication, control plane |
| **Surface** | backend, db |
| **Size** | M |

**Goal** — a read of `platform.superusers` does not yield usable TOTP secrets, and every superuser login — success and failure — is in `platform.platform_audit_logs`.

**Steps**
1. Encrypt `totp_secret` with a key ring separate from the tenant PII key (a control-plane key), versioned like `pii.ts`.
2. An online, re-runnable migration step (or `ops` script) to encrypt existing secrets; the `CHECK` constraint keeps requiring a secret.
3. Write login success, failure, and TOTP failure to the platform audit trail.

**Definition of Done**
- A test reads the column as `hrms_owner` and asserts ciphertext.
- Existing superusers still log in after migration (tested against a seeded superuser via `pnpm dev:totp`).
- Login events appear in the platform audit trail.
- `docs/PLAN/17` §4, `docs/SECURITY/02` §9, `docs/SECURITY/03` D-8, risk F13 updated.

### P6-15 — Constant-time comparison of the internal secret

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/SECURITY/02` §10(b), `apps/auth/src/server.ts` |
| **Spec required** | No |
| **Surface** | auth |
| **Size** | S |

**Definition of Done** — `x-internal-secret` compared with `timingSafeEqual` over equal-length buffers (hash both first); existing `service.test.ts` secret-guard tests still pass; a test with a secret of different length returns `404` without throwing.

### P6-16 — Alerting: the first four alerts

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P1 |
| **Blocked by** | `OQ-06` (recipient), `OQ-09` (log destination) |
| **Plan refs** | `docs/SECURITY/03` §Priority Alerts, `docs/PLAN/19` §6, risk F3 |
| **Spec required** | No |
| **Surface** | ops, worker |
| **Size** | M |

**Goal** — D-1 (schema drift), D-2 (refresh token reuse), D-3 (failed-login spike), and D-9 (auth service unreachable) reach a person.

**Definition of Done** — each alert triggered deliberately on staging and received; the procedure recorded; `docs/SECURITY/03` table marks them built.

### P6-17 — Off-host backups and PII key escrow

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P1 |
| **Blocked by** | `OQ-02` (destination, key holders), `OQ-12` (RPO/RTO) |
| **Plan refs** | `docs/PLAN/20` §6–7, `ops/RUNBOOK.md` §6–8, `docs/SECURITY/04` Playbook 4, risk F4 |
| **Spec required** | Yes — personal data leaves the host |
| **Surface** | ops |
| **Size** | M |

**Goal** — the dump, storage archive, and WAL archive copied off the host, encrypted before they leave; the PII and signing keys held by named people outside the host.

**Definition of Done** — a restore performed on a **different** machine from the off-host copy alone, plus the escrowed keys, with row counts and file hashes matching; recorded; `docs/PLAN/20` §6–7 and risk F4 updated.

### P6-18 — API documentation: coverage, interactive page, and secret-header access

| | |
|---|---|
| **Status** | SPEC |
| **Priority** | P1 — requested by the user |
| **Depends on** | — |
| **Blocked by** | `OQ-11` for `P6-18.3` only |
| **Plan refs** | `docs/PLAN/15` §10, `apps/web/src/lib/openapi.ts`, `docs/PLAN/17` §8 |
| **Spec required** | Yes — authentication (a secret), exposure of the API surface |
| **Surface** | web, backend, db |
| **Size** | L — three sub-tasks |

**Goal** — every tenant route is documented, a logged-in administrator can browse the documentation interactively, and access additionally requires a secret header whose value only the platform operator knows, stored protected in the database.

**Sub-tasks**

- **P6-18.1 — Coverage test.** A test in `apps/web/test/` that fails when a `ROUTE_MANIFEST` entry has no `DOCS` entry, with an explicit allowlist that starts with the 86 undocumented routes and may only shrink. Seen to fail by adding a route. Removes the false claim in `openapi.ts` (`PG-04`). **Size S. Not blocked.**
- **P6-18.2 — Document the remaining routes.** Fill `DOCS` for all 100 routes, module by module, shrinking the allowlist to zero. **Size L. Not blocked.**
- **P6-18.3 — Interactive page with secret-header access.** A page rendering Swagger UI (or Scalar/Redoc) from `/api/openapi.json`, available only to a session holding `core.settings.manage` **and** a request carrying the secret header. Design questions in `OQ-11`; draft spec `MEMORY/specs/P6-18-api-documentation-access.md`. **Blocked by `OQ-11`.**

**Definition of Done**
- `P6-18.1` and `P6-18.2` as above.
- `P6-18.3`: without a session → refused; with a session lacking the permission → `403`; with both but a wrong or missing header → `404`; a timing-safe comparison; the secret never logged; stored so that a database read does not reveal it; rotation with two active values.
- The interactive page loads its assets without breaking the CSP from `P6-12`.
- `docs/PLAN/15` §10 updated.

**Abuse cases to test** — `SECURITY/02` §12 enumeration of the API surface by a non-administrator; brute force of the secret header (rate-limited per session and per address after `P3-12`); the secret leaking through logs or the OpenAPI document itself.

### P6-19 — Structural test: every `[id]` route checks ownership

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Plan refs** | `docs/SECURITY/02` §1(c), `docs/SECURITY/05` Order of Work |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Goal** — a route with a dynamic segment whose manifest permission is `.own` or `.team`-scoped cannot ship without an ownership or scope check.

**Definition of Done** — a test enumerating `[id]`/`[key]` routes with `.own`/`.team` permissions and requiring each either to appear in an allowlist with a one-line justification or to have a gateway-level test proving a second employee is refused. Seen to fail by adding such a route with no check.

### P6-20 — Tests for account lockout and login timing

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Plan refs** | `docs/SECURITY/02` §2, §12; `packages/core/src/auth/login.ts` |
| **Spec required** | No — coverage |
| **Surface** | backend |
| **Size** | S |

**Definition of Done** — against real PostgreSQL: 8 failures lock the account with `ACCOUNT_LOCKED` and `retry-after`; the correct password is refused while locked; the lock expires after 15 minutes (clock injected, not slept); an unknown tenant and a wrong password take comparable time within a stated tolerance over repeated runs. Seen to fail with `MAX_FAILED_ATTEMPTS` raised.

### P6-21 — Load test the morning peak

| | |
|---|---|
| **Status** | BLOCKED |
| **Priority** | P2 |
| **Blocked by** | `OQ-05` (capacity assumptions), `P0-10` (staging) |
| **Plan refs** | `docs/PLAN/18` §6, `docs/PLAN/12` §11, risk R17 |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | L |

**Goal** — measured p95 latency and error rate for the 07:30–08:30 WIB shape: punch bursts with photos, offline queue replays arriving together, the live dashboard open, at 3× the stated envelope, in both the in-process and split topologies.

**Definition of Done** — results against the p95 < 500 ms target recorded with host size and data volume; `docs/PLAN/18` §2–3 updated; any failure becomes a task.
