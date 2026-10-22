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
| **Status** | DONE |
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

**Implemented** (2026-10-21; reviewed and corrected 2026-10-22)
- `apps/web/next.config.ts` sets CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`. The reasoning for each directive is in the config's comment.
- The review fixed three defects in the first version: `img-src` lacked `blob:`, which blocked the punch photo preview; `'unsafe-eval'` was allowed in production builds; `upgrade-insecure-requests` broke plain-HTTP LAN access. `https:` sources were removed — the app loads nothing from another origin.
- `apps/web/test/security-headers.test.ts` asserts the real config, including each of the three fixes.

**Verification**
- A production build in Chromium (Playwright): no CSP violations on the pocket pages; a `blob:` image loads; the service worker registers.
- Known limit: `script-src 'unsafe-inline'` remains, because the App Router streams inline scripts. Removing it needs per-request nonces; risk F5 stays partly open in `docs/SECURITY/02` §13.

### P6-13 — Permission ceiling for role and grant administrators

| | |
|---|---|
| **Status** | DONE — 2026-10-22 ([record](../MEMORY/records/2026-10-22-permission-ceiling.md), ADR-035) |
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
| **Status** | DONE — 2026-10-22 ([record](../MEMORY/records/2026-10-22-superuser-totp.md)) |
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
| **Status** | DONE — 2026-10-22 |
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
| **Status** | IN PROGRESS — 18.1 DONE; 18.2 DONE (2026-10-22); 18.3 TODO |
| **Priority** | P1 — requested by the user |
| **Depends on** | `P6-12` for `P6-18.3` (the page must load under the CSP) |
| **Blocked by** | — |
| **Plan refs** | `docs/PLAN/15` §10, `apps/web/src/lib/openapi.ts`, `docs/PLAN/17` §4 and §8, `MEMORY/specs/P6-18-api-documentation-access.md` (Reviewed) |
| **Spec required** | Yes — written and reviewed |
| **Surface** | web, backend, db, ops |
| **Size** | L — three sub-tasks |

**Goal** — every tenant route is documented; a platform superuser can browse the documentation interactively; access additionally requires a secret header only the platform operator knows, stored as an Argon2id hash.

**Sub-tasks**

- **P6-18.1 — Coverage test.** A test in `apps/web/test/` that fails when a `ROUTE_MANIFEST` entry has no `DOCS` entry, with an explicit allowlist that starts with the 86 undocumented routes and may only shrink. Seen to fail by adding a route. Corrects the false claim in `openapi.ts` (`PG-04`). **Size S.**
- **P6-18.2 — Document the remaining routes.** Fill `DOCS` for all 100 routes, module by module, shrinking the allowlist to zero. Summaries and descriptions in English (ADR-030). **Size L.**
- **P6-18.3 — Interactive page with secret-header access.** **Size M.**
  1. Migration: `platform.api_docs_keys` (`id`, `hash`, `created_at`, `expires_at`, `created_by`), granted to `hrms_platform` only.
  2. `ops/scripts/set-docs-key.mjs`: generates ≥ 32 random bytes, prints the secret once, stores the Argon2id hash, optionally sets the previous key to expire in 24 hours.
  3. `packages/core/src/platform/docs-keys.ts`: verify a presented key against unexpired hashes.
  4. Control-plane routes in `ADMIN_ROUTE_MANIFEST`: `GET /admin/api/docs/openapi.json`, guarded by a superuser session **and** `X-Docs-Key`.
  5. A page under `/admin` that asks for the key, holds it in memory only, fetches the JSON with the header, and renders it with a pinned documentation package (no CDN).
  6. Remove the tenant route `GET /api/openapi.json` and its manifest entry.

**Definition of Done**
- `P6-18.1` and `P6-18.2` as above.
- `P6-18.3`, through the real admin route handlers against real PostgreSQL: no session → `401`; a tenant token → refused; a superuser without the header or with a wrong or expired key → `404`; a valid key → `200`; two valid keys during rotation both work; repeated wrong keys → `429`.
- A test asserts the stored value is an Argon2id hash and never the secret; a test asserts the header is redacted from logs.
- `platform_audit_logs` rows for key creation, expiry, and documentation access.
- The page loads under the CSP from `P6-12` with zero violations.
- `docs/PLAN/15` §10, `docs/PLAN/17` §4 and §8, `docs/SECURITY/02` §12 updated.

**Abuse cases to test** — `SECURITY/02` §12 enumeration of the API surface by a tenant user or anonymous caller; brute force of the key (rate-limited per session and per trusted address after `P3-12`); the key leaking through logs, the OpenAPI document, or the page source; a timing difference between "no key configured" and "wrong key".

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
| **Status** | DONE — 2026-10-22 (`apps/web/test/login-lockout.test.ts`, ADR-036) |
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
| **Priority** | P3 — first-year volume is small (ADR-033) |
| **Blocked by** | `P0-10` (staging) |
| **Plan refs** | `docs/PLAN/18` §6, `docs/PLAN/12` §11, risk R17 |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | L |

**Goal** — measured p95 latency and error rate for the morning shape at 3× the first-year envelope (ADR-033): 1,800 punches with photo uploads within 15 minutes across 3 tenants, a burst of 100 offline replays at once, and a live dashboard open per tenant — in the in-process topology (the split is not enabled, ADR-032).

**Definition of Done** — results against the p95 < 500 ms target recorded with host size and data volume; `docs/PLAN/18` §2–3 updated; any failure becomes a task.

### P6-24 — English backend messages with machine-readable reasons

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 — decided 2026-09-14 (`OQ-01`, ADR-030) |
| **Depends on** | — |
| **Blocked by** | — |
| **Plan refs** | `docs/PLAN/15` §6 and §11, `packages/contracts/src/errors.ts`, `docs/UI-UX/13` §1, ADR-030, ADR-034 |
| **Spec required** | Yes — changes the error contract every endpoint returns |
| **Surface** | backend, auth, worker, contracts |
| **Size** | L — split per module |

**Goal** — everything the backend produces — API error messages, validation messages, logs, debug output — is English, every refusal a user can meet carries a stable machine-readable reason the frontend can turn into Indonesian text, and the emails and push notifications people read are Indonesian (ADR-034).

**Steps**
1. Spec: the reason field. Recommended: an optional `error.reason` (`SCREAMING_SNAKE`, e.g. `PUNCH_EVIDENCE_REQUIRED_OFF_NETWORK`, `LEAVE_INSUFFICIENT_BALANCE`, `LEAVE_SELF_APPROVAL`), with parameters in `error.details` (e.g. `{ "missing": ["location", "photo"] }`). `code` stays the coarse contract; `reason` refines it. Validation errors: `details` keyed by field, carrying Zod issue codes and bounds (`too_small`, `minimum: 12`) rather than sentences.
2. Define reasons once in `packages/contracts` so the frontend can import the list.
3. Module by module (`auth`, `iam`, `employee`, `attendance`, `leave`, `payroll`, `tenant`, `platform`, `notification`, worker): translate remaining Indonesian string literals to English and attach reasons to user-facing refusals. A rough search on 2026-09-14 found about 237 such literals in about 77 files — measure precisely in the spec.
4. Replace the Indonesian messages in `packages/contracts` schemas (e.g. `passwordSchema`) with English.
5. Email and push templates back to **Indonesian** (ADR-034): `packages/core/src/notification/templates.ts` (invitation, password reset, contract and document expiry) and the push text in `apps/worker/src/leave-notify.ts`. Keep the push deliberately thin — no reason or comment on a lock screen. Use `docs/UI-UX/13` §4 vocabulary.
6. Tests assert on `code` and `reason`, never on message text.

**Definition of Done**
- No Indonesian string literal remains in backend source except seeded display data (menu labels, leave-type and holiday names — ADR-030) and notification templates (ADR-034) — enforced by a test that searches backend source for a list of common Indonesian words, with an explicit allowlist for seed files and the template files. Seen to fail by adding one.
- A test renders each email template and the leave push and asserts Indonesian text (for example the subject of the password reset email) — so a future translation pass cannot silently switch them back.
- Every refusal in `docs/UI-UX/04` flows returns a documented `reason`.
- `docs/PLAN/15` §6 lists the reasons; `openapi.ts` documents `reason` on error responses.
- `pnpm verify` passes.

**Abuse cases to test** — none new; the change must not add information to refusals that `docs/SECURITY/02` §12 deliberately withholds (login failures stay a single `INVALID_CREDENTIALS` with no reason).

