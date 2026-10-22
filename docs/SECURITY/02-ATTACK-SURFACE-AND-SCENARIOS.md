# 02 — Attack Surface and Scenarios

Every scenario follows the same chain: **Asset → Trust Boundary → Threat Actor → Attack Surface → Scenario → Impact → Likelihood → Mitigation → Detection → Response**, with a **Status** saying whether the mitigation exists today. Asset and boundary ids are from `00-ASSET-AND-TRUST-BOUNDARY-INVENTORY.md`; actors are from `01-THREAT-ACTOR-PROFILES.md`.

This is the core document of `SECURITY/`. Feature specs cite its section numbers in their abuse cases, and tests name the scenario they exercise.

> **Scope note:** these scenarios model attacks against **this system**, for defensive design and for verifying its own controls. They are not a guide to attacking anyone else's system, and `05-VERIFICATION-AND-REDTEAM-PLAN.md` is scoped to authorized testing of this system's own environments.

Status values: **Mitigated** (control exists and is tested) · **Partial** (control exists with a stated gap) · **Open** (no effective control) · **Accepted** (a residual risk deliberately taken, with a reason).

---

## 1. Cross-Tenant and Cross-Object Access

| Field | Detail |
|---|---|
| Asset | Every tenant-scoped asset; A-1, A-3, A-4 in particular |
| Trust Boundary | TB-3, TB-4, TB-5 |
| Threat Actor | Actor 6 (another tenant), Actor 2 (colleague) |
| Attack Surface | Every endpoint taking an id: `/api/employees/[id]`, `/api/documents/[docId]`, `/api/attendance/photo/[key]`, `/api/leave/attachments/[key]`, `/api/payroll/runs/[id]` |
| Scenario | (a) A user of tenant B substitutes an id belonging to tenant A. (b) A user sends `X-Tenant-ID` of tenant A with a tenant B token. (c) An employee substitutes a colleague's photo key or document id within the same tenant |
| Impact | (a)(b) cross-tenant exposure — ends the product (R4). (c) colleague PII or evidence exposed |
| Likelihood | Medium for (c) — a coding-discipline risk on every new endpoint. Low for (a)(b) given RLS |
| Mitigation | (a) RLS `FORCE` with fail-closed context: tenant A's row does not exist inside tenant B's transaction, whatever the handler forgets. Composite `(tenant_id, employee_id)` FKs, because FKs are checked without RLS. (b) the header only confirms the token's `tid` → `403 TENANT_MISMATCH`. (c) **not covered by RLS** — each handler checks ownership: the photo route allows `attendance.review.handle` or the punch's own employee, else `403` |
| Detection | `tenant-isolation.test.ts`, `rls-coverage.test.ts`, `gateway.test.ts`; `schema_drift_report()` daily for a table losing RLS |
| Response | `../../ops/RUNBOOK.md` §3; `04-INCIDENT-RESPONSE-PLAYBOOKS.md` "Cross-tenant exposure" |
| Status | (a)(b) **Mitigated**. (c) **Partial** — per-handler, with no structural test that every `[id]` route checks ownership |

## 2. Authentication Attacks

| Field | Detail |
|---|---|
| Asset | A-6 |
| Trust Boundary | TB-1 |
| Threat Actor | Actor 4 (external), Actor 5 (compromised account) |
| Attack Surface | `POST /api/auth/login`, `POST /api/auth/password/forgot`, reset, invitation acceptance, `POST /admin/api/auth/login` |
| Scenario | (a) Credential stuffing across many accounts from many addresses. (b) Online guessing against one account. (c) A breached password reused from another site, logging in on the first try |
| Impact | Account takeover; for an HR administrator, the tenant's full HR data |
| Likelihood | High for (a) and (c) — automated and cheap |
| Mitigation | Argon2id. Account lock after 8 failures for 15 minutes with `retry-after`. Login rate-limited to 20 per 5 minutes **per address**, shared across replicas through Redis. An unknown tenant costs the same time as a wrong password. Refresh token reuse revokes the family |
| Detection | `auth.login.failed` and `auth.login.locked` audit rows. **No alert** on a spike (`03`) |
| Response | `04` "Credential stuffing" |
| Status | (b) **Mitigated** — `login-lockout.test.ts` (P6-20): 8 failures lock with `423 ACCOUNT_LOCKED` and `Retry-After`, the right password is refused while locked, the lock expires after 15 minutes. (a) **Partial** — per-address limits are bypassable (§4), and distributed stuffing stays under per-address limits anyway. (c) **Open** — no tenant-user MFA (R18), no breached-password check, no new-device notification |

## 3. Token and Session Attacks

| Field | Detail |
|---|---|
| Asset | A-6, A-7, A-16 |
| Trust Boundary | TB-1, TB-6, TB-9 |
| Threat Actor | Actor 4, Actor 5, Actor 7 |
| Attack Surface | `Authorization` header, `hrms_rt` cookie, JWKS, `/api/auth/refresh` |
| Scenario | (a) Forge a token with `alg: none`, or sign HS256 using the public key as the secret. (b) Present a control-plane token to the tenant plane or the reverse. (c) Steal the refresh token. (d) Keep using a token after the user's permissions were reduced. (e) Keep using a token after the tenant was suspended. (f) Mint tokens with a leaked `JWT_SECRET` |
| Impact | (a)(b)(f) session for any user of any tenant. (c) persistent access. (d) access beyond current grants |
| Likelihood | Low for (a)(b); Medium for (c)(d) |
| Mitigation | (a) the algorithm comes from the key, never the token — tested. (b) separate audiences and key realms. (c) `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`; rotated per use; reuse revokes the family. Access token in memory only, 15-minute TTL. (d) access version `av` compared on every request → `401 TOKEN_STALE`. (e) checked at login and refresh |
| Detection | `TOKEN_REUSE_DETECTED` audit rows; readiness reports `signing: hybrid` while (f) is possible |
| Response | `04` "Signing key compromise" |
| Status | (a)(b)(c)(d) **Mitigated**. (e) **Accepted** — a live access token survives suspension for at most 15 minutes, by decision recorded in `packages/core/src/platform/tenant-admin.ts`. (f) **Partial** — EdDSA is the default, but HS256 still verifies while `JWT_SECRET` is set, and `ops/.env.compose.example` sets it |

## 4. Client Address Spoofing Through `X-Forwarded-For`

| Field | Detail |
|---|---|
| Asset | A-3 (evidence integrity), A-6 (via rate limits), A-12 (address in audit rows) |
| Trust Boundary | **TB-2** |
| Threat Actor | **Actor 1 (employee gaming attendance)**, Actor 4 (external) |
| Attack Surface | Every request. Resolved by one `clientAddress()` helper in `packages/observability/src/client-address.ts`, used by `apps/web/src/lib/define-route.ts`, `apps/web/src/lib/define-admin-route.ts`, and `apps/auth/src/http.ts` |
| Scenario | The client sends its own `X-Forwarded-For: 203.0.113.10`. The reference proxy (`ops/proxy/proxy-common.inc`) uses `$proxy_add_x_forwarded_for`, which **appends** the real address: `203.0.113.10, <real>`. The application takes the **first** entry — the one the client wrote. The proxy also sets `X-Real-IP $remote_addr` correctly, but the code reads it only when `X-Forwarded-For` is absent. **In the default Compose topology there is no proxy at all**: `web` is published directly on port 3000 (the proxy exists only in the `split` profile), so both headers are entirely client-supplied. (a) An employee at home claims the office network's address: the punch is marked `OFFICE_IP_VERIFIED`, the `WEB_UNVERIFIED_DEVICE` penalty is removed, and `FALLBACK_ONLY` accepts a punch with no location or photo. (b) An attacker rotates the header on every login attempt: each attempt counts against a different "address", so the per-address login limit never trips. (c) Audit rows record whatever address the client chose |
| Impact | (a) The one browser signal documented as unforgeable (`../PLAN/11-PWA-Frontend.md` §2.2) is forgeable; HR trusts punches it should review. (b) Credential stuffing proceeds unthrottled except by per-account lockout. (c) Investigations are misled |
| Likelihood | **High** for (a) — the motivated actor repeats daily and needs one browser extension. Medium for (b) |
| Mitigation | `clientAddress()` reads **only** `X-Real-IP`, and only when `TRUST_PROXY=true` (the reference nginx sets it from `$remote_addr`). `X-Forwarded-For` is never read. With `TRUST_PROXY` unset or `false` — the default, and the entire default Compose topology — every forwarding header is ignored and the address is `unknown`: office verification never matches, all per-address limits share one bucket, and audit rows record null. The backend forwards the resolved address to `apps/auth` in `X-Forwarded-Client-IP`, trusted only when the internal secret is valid. Spec: `MEMORY/specs/P3-12-trusted-client-address.md` |
| Detection | `packages/observability/test/client-address.test.ts` covers every §14 row decidable without a proxy; `clientAddressMode()` is reported by `/api/ready` so a misconfiguration is visible from outside |
| Response | Punches recorded with `OFFICE_IP_VERIFIED` since migration `20260901090000` cannot be re-verified. Decided (spec §21): leave them, and provide a per-tenant script listing them for the tenant to review — history is not rewritten (P13) |
| Status | **Mitigated** — 2026-10-21 (`P3-12`). Risk `F1` in `../PLAN/22-RISK-REGISTER.md` closed |
| Verification | `client-address.test.ts`: a spoofed `X-Forwarded-For` through the trusted helper yields the proxy-observed address, not the client's; the same header with `TRUST_PROXY=false` yields `unknown`; the forwarded header is ignored without the internal secret |

## 5. Privilege Escalation and Self-Approval

| Field | Detail |
|---|---|
| Asset | A-10, A-4, A-5 |
| Trust Boundary | TB-3 |
| Threat Actor | Actor 2, Actor 3 |
| Attack Surface | `PUT /api/roles/[id]/permissions` (`iam.role.manage`), `PUT /api/users/[id]/grants` (`iam.grant.manage`), leave approval, payroll run approval |
| Scenario | (a) A user holding `iam.role.manage` adds `payroll.run.execute` to their own role, or a holder of `iam.grant.manage` grants it to themselves directly. (b) A manager approves their own leave. (c) A requester nominates an approver who does not hold the approval permission. (d) A DENY grant is ignored because a role grants the same permission |
| Impact | Access beyond intent; fraudulent leave or pay |
| Likelihood | Medium |
| Mitigation | (a) a permission ceiling (ADR-035, `packages/core/src/iam/ceiling.ts`): nobody but a `TENANT_OWNER` holder confers a permission they do not hold — role additions, GRANTs, lifting a DENY, invitations into a role — or changes the owner role or an owner's grants; refused `403 PERMISSION_CEILING`. (b) self-approval refused without exception, including for HR administrators. (c) the approver must actually hold the permission. (d) DENY beats roles in `resolveEffectiveAccess`. Every role and grant change bumps the access version |
| Detection | Audit rows on role, grant, and approval changes. No alert on them |
| Response | Revoke; review the audit trail for everything the escalated access touched |
| Status | (c)(d) **Mitigated** (`leave-approver.test.ts`, `gateway.test.ts` DENY precedence). (b) **Mitigated** — `leave-approval-controls.test.ts` (P4-08) refuses self-approval as a manager, an HR administrator, and `TENANT_OWNER`, through the real handlers. (a) **Mitigated** — 2026-10-22 (`P6-13`): `apps/web/test/permission-ceiling.test.ts` drives each abuse case, including the owner lockout, through the real route handlers |

## 6. Subscription Bypass

| Field | Detail |
|---|---|
| Asset | A-11 |
| Trust Boundary | TB-3 |
| Threat Actor | Actor 6 |
| Attack Surface | Any endpoint of an unsubscribed module, called directly |
| Scenario | The menu hides payroll; the tenant calls `/api/payroll/*` anyway. Or keeps using a module after downgrading |
| Impact | Revenue loss; entitlement data meaningless |
| Likelihood | Medium |
| Mitigation | `decideAccess` checks the module before the permission → `402`. An entitlement change bumps the tenant generation, invalidating cached access |
| Detection | `402` counts per route in metrics |
| Response | None needed per incident |
| Status | **Mitigated** |

## 7. Attendance Evidence Fraud

| Field | Detail |
|---|---|
| Asset | A-3 |
| Trust Boundary | TB-9 |
| Threat Actor | Actor 1 |
| Attack Surface | `POST /api/attendance/punch`, `POST /api/attendance/photo`, the offline queue |
| Scenario | (a) Mock GPS in the browser. (b) A photo of a photo, or a colleague's selfie. (c) A colleague punches on someone else's unlocked phone. (d) The device clock set back, with the punch queued offline and replayed later. (e) Withholding location permission to avoid the geofence |
| Impact | Paid time not worked; HR loses trust in attendance |
| Likelihood | **High** |
| Mitigation | Scored, never auto-rejected (P14). (a) browser punches carry `WEB_UNVERIFIED_DEVICE`; `MOCK_LOCATION` when reported; `LOW_GPS_ACCURACY`; `OUTSIDE_GEOFENCE`. (b) a photo is required per policy and reviewed by a human; no face matching (R45). (d) `CLOCK_SKEW` beyond 5 minutes against server time. (e) `BLOCK` / `ALLOW_FLAGGED` / `FALLBACK_ONLY` policy; consent withdrawal honoured and not penalised |
| Detection | The review queue; the flagged ratio on the dashboard |
| Response | HR review; the employee sees the flag reason |
| Status | **Partial by design** — the product claims detection and review, not prevention (R39). `FALLBACK_ONLY` and office verification are currently defeated by §4. Offline replays legitimately carry old timestamps, so (d) is a scoring signal only |

## 8. Personal Data Exposure

| Field | Detail |
|---|---|
| Asset | A-1, A-2, A-5 |
| Trust Boundary | TB-3, TB-10, TB-12 |
| Threat Actor | Actor 2, Actor 3, Actor 7 |
| Attack Surface | Employee list, detail, export, import, documents, leave attachments, logs, the portability export |
| Scenario | (a) A user without unmask permission reads a national ID through the export instead of the detail screen. (b) PII reaches logs through an error message. (c) Import staging keeps plaintext PII after a failed import. (d) A database dump leaks. (e) HR unmasks everyone's national ID in bulk |
| Impact | PDP Act breach; identity theft |
| Likelihood | Medium |
| Mitigation | AES-256-GCM with a key ring; blind index for lookup. Masked by default in list, detail, **and** export; unmask requires `employee.pii.unmask`. An export records whether it was unmasked (`employee.exported`). Logs redact national IDs, bank accounts, passwords, and bearer tokens — tested. Staging stores no plaintext PII. The portability export omits ciphertext |
| Detection | Export audit rows only. **Viewing unmasked PII in the list or detail writes no audit row** |
| Response | `04` "Personal data breach" — 72-hour notification clock (R9) |
| Status | (a)(b)(c)(d) **Mitigated**. (e) **Open** — bulk unmasking through the list or detail views leaves no trace; only exports are audited. `12` Phase 2 DoD requires unmasking to be audited |

## 9. Control-Plane Abuse

| Field | Detail |
|---|---|
| Asset | A-9, A-11, A-13 |
| Trust Boundary | TB-6 |
| Threat Actor | Actor 7, Actor 4 |
| Attack Surface | `/admin/api/**`, `platform.superusers` |
| Scenario | (a) A superuser reads tenant employee data "for support". (b) A stolen superuser password. (c) A database read of `platform.superusers` yields TOTP secrets, defeating the second factor |
| Impact | (a) every tenant's data. (b)(c) control-plane takeover: suspend, change plans |
| Likelihood | Low |
| Mitigation | (a) `hrms_platform` has no grant on `auth.users`, `iam.*`, `audit.*`, or tenant module schemas — tested; a separate audience and key realm. (b) TOTP mandatory, enforced by a `CHECK` constraint; 8-hour sessions |
| Detection | `platform_audit_logs` records tenant status and plan changes, and every superuser login — `superuser.login.succeeded`, `superuser.login.failed` with its reason (P6-14) |
| Response | Rotate `ADMIN_JWT_*`; re-enrol TOTP |
| Status | (a)(b)(c) **Mitigated** — (c) since 2026-10-22 (`P6-14`): `totp_secret` is AES-256-GCM-sealed under `PLATFORM_ENCRYPTION_KEY`, a ring separate from the PII keys; `superuser-login.test.ts` reads the column as `hrms_owner` |

## 10. Internal Service Boundary

| Field | Detail |
|---|---|
| Asset | A-14, A-10 |
| Trust Boundary | TB-7 |
| Threat Actor | Actor 4 (if the auth service is reachable), Actor 7 |
| Attack Surface | `POST /internal/authorize` on the auth service |
| Scenario | (a) An external caller reaches the internal route and asks for an authorization decision. (b) A timing attack on the secret comparison. (c) The backend falls back to local authorization when auth is down |
| Impact | (a) authorization oracle; (c) bypass of a revocation the auth service knows about |
| Likelihood | Low |
| Mitigation | (a) `x-internal-secret` required; a wrong or missing secret returns `404`, not `403`, so the route is not confirmed. The proxy does not route `/internal/*`. (c) unreachable auth is `503`, never a local fallback |
| Detection | Auth service logs |
| Response | Rotate `AUTH_INTERNAL_SECRET` |
| Status | (a)(c) **Mitigated**. (b) **Mitigated** — 2026-10-22 (`P6-15`): one helper, `internalSecretValid` in `apps/auth/src/http.ts`, hashes both values and compares with `timingSafeEqual`; `service.test.ts` holds the router to it. Shared secret rather than mTLS (`14` §10.6). **This boundary exists only when the auth service is enabled, which is not planned** (ADR-032) |

## 11. File Upload Abuse

| Field | Detail |
|---|---|
| Asset | A-2, A-3, A-5; the host |
| Trust Boundary | TB-10, TB-11 |
| Threat Actor | Actor 2, Actor 4 (via a compromised account) |
| Attack Surface | Photo, document, leave attachment, employee import, attendance machine import |
| Scenario | (a) An HTML or SVG file uploaded as a "PDF" and served back to HR, executing script. (b) A path in the filename writes outside storage. (c) Oversized files exhaust disk. (d) A selfie carrying GPS EXIF leaks the employee's home location to HR |
| Impact | Stored XSS against HR; host compromise; disk exhaustion; privacy breach |
| Likelihood | Medium |
| Mitigation | (a) type from magic bytes, not name or `content-type`. (b) storage keys are server-generated. (c) limits: photo 512 KB, leave attachment 5 MB, document 10 MB, imports 10 MB. (d) EXIF stripped from every photo |
| Detection | Rejected-upload errors in logs |
| Response | Delete the object; review who downloaded it |
| Status | **Mitigated**. No malware scanning; no per-tenant storage quota |

## 12. Enumeration

| Field | Detail |
|---|---|
| Asset | A-13, A-6 |
| Trust Boundary | TB-1 |
| Threat Actor | Actor 4 |
| Attack Surface | Login, forgot password, tenant registration, invitation acceptance |
| Scenario | (a) Discover which emails have accounts. (b) Discover which tenant codes exist. (c) Discover internal routes |
| Impact | Targeting for §2 |
| Likelihood | Medium |
| Mitigation | (a) login does not distinguish email, password, or tenant, and costs equal time — an argon2 burn plus a 250 ms floor on every refusal (ADR-036; before it, a wrong password took 40 ms and an unknown email 26 ms), held by `login-lockout.test.ts`; forgot-password always `204`. (b) registration reveals a taken tenant code by necessity, rate-limited to 5 per hour per address. (c) internal and unknown-method requests return `404` |
| Detection | Rate-limit refusals |
| Response | — |
| Status | (a)(c) **Mitigated**. (b) **Accepted**, with the per-address limit bypassable through §4 |

## 13. XSS and Missing Browser Security Headers

| Field | Detail |
|---|---|
| Asset | A-16, and everything the victim's session reaches |
| Trust Boundary | TB-1 |
| Threat Actor | Actor 2, Actor 4 |
| Attack Surface | Any rendered user-supplied text: employee names, leave reasons, document names, work site names |
| Scenario | Script in a leave reason executes in the approver's browser and calls the API with the approver's in-memory token |
| Impact | Actions as the victim — for HR, the whole tenant |
| Likelihood | Low while React escaping holds; the damage is uncontained if it does not |
| Mitigation | React escapes by default. The refresh token is `HttpOnly`, so script cannot steal it — but script can still **use** the session while the page is open |
| Detection | None |
| Response | Remove the payload; rotate affected sessions by bumping access versions |
| Status | **Partial** — no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, or `frame-ancestors` are set anywhere (`F5`) |

## 14. API Abuse and Noisy Neighbour

| Field | Detail |
|---|---|
| Asset | Availability for every tenant |
| Trust Boundary | TB-1, TB-4 |
| Threat Actor | Actor 6, Actor 4 |
| Attack Surface | Heavy endpoints: exports, imports, dashboard trends, the live stream |
| Scenario | One tenant floods the API or opens many live streams at 08:00, degrading punching for every other tenant |
| Impact | Other tenants cannot clock in during the morning peak |
| Likelihood | Medium |
| Mitigation | Per-tenant quota of 600 requests/minute, checked before a connection is taken; per-role `statement_timeout`; 32 live streams per process, then polling; overload answers `503` + `retry-after`, never `500` |
| Detection | `429` / `503` counts in metrics; quota refusals logged at `warn` |
| Response | Adjust the tenant's quota |
| Status | **Partial** — never load-tested (`../PLAN/18-PERFORMANCE-AND-CAPACITY.md`); low exposure in year one — 3 tenants, ≤ 600 employees (ADR-033) |

## 15. Location Surveillance Beyond Purpose

| Field | Detail |
|---|---|
| Asset | A-3 |
| Trust Boundary | TB-3 |
| Threat Actor | Actor 3 |
| Attack Surface | Punch records, the live dashboard, exports, photos |
| Scenario | A manager uses attendance coordinates to track where an employee goes, or builds a movement history |
| Impact | PDP Act purpose-limitation breach; employee trust (R41, R44) |
| Likelihood | Medium |
| Mitigation | Location captured only at the moment of a punch; never in the background (P15). The live dashboard payload carries no coordinates. HR photo access is logged. Consent can be withdrawn without penalty |
| Detection | `photo_access_logs` |
| Response | Access review; policy enforcement is the tenant's |
| Status | **Mitigated** in the product; a written usage policy for tenants does not exist |

## 16. Shared-Device and Offline Data Leak

| Field | Detail |
|---|---|
| Asset | A-16 |
| Trust Boundary | TB-9 |
| Threat Actor | Actor 2 (the next person using the kiosk or shared phone) |
| Attack Surface | Service worker cache, IndexedDB offline queue, browser HTTP cache |
| Scenario | Employee A logs out of a shared phone; employee B opens the app and reads A's payslip or attendance from cache |
| Impact | Colleague data exposure (R50) |
| Likelihood | Medium — shared devices are common in the target market |
| Mitigation | The service worker never caches API, admin, or credential paths, or any `Authorization`-bearing request — tested. Photos served `no-store`. Access token in memory only. Cache and push subscription wiped on logout |
| Detection | `service-worker.test.ts` |
| Response | — |
| Status | **Mitigated** in tests; **not verified on a physical shared device** |

## 17. Audit Log Integrity

| Field | Detail |
|---|---|
| Asset | A-12 |
| Trust Boundary | TB-4, TB-12 |
| Threat Actor | Actor 3, Actor 7 |
| Attack Surface | `audit.audit_logs` |
| Scenario | An HR administrator alters pay, then deletes or edits the audit row |
| Impact | Undetectable fraud |
| Likelihood | Low |
| Mitigation | `UPDATE` and `DELETE` revoked from runtime roles **and** blocked by trigger — tested. Superuser actions in a separate trail |
| Detection | — |
| Response | — |
| Status | **Mitigated** against the application. **Not** against Actor 7 as table owner; no off-host log copy |

## 18. Secrets, Supply Chain, and CI

| Field | Detail |
|---|---|
| Asset | A-7, A-8, A-14, A-15 |
| Trust Boundary | TB-12 |
| Threat Actor | Actor 7, Actor 8 |
| Attack Surface | `.env` files, `ops/.env.compose.example`, `pnpm-lock.yaml`, base images, backups |
| Scenario | (a) A real secret committed. (b) A malicious dependency update exfiltrates `PII_ENCRYPTION_KEY` from the process environment. (c) Backups on the same host are lost or stolen with the host. (d) A known-vulnerable dependency stays in the tree |
| Impact | Every tenant's PII decryptable; tokens mintable |
| Likelihood | Medium |
| Mitigation | `.env` files ignored by git; lockfile pinned; keys generated by scripts, not committed |
| Detection | **None automated** |
| Response | `04` "Secret exposure" |
| Status | **Open** — no CI, so no secret scanning, dependency audit, or image scanning (F2); backups on-host only (F4) |

## 19. Guard Erosion

| Field | Detail |
|---|---|
| Asset | Every control above |
| Trust Boundary | The repository |
| Threat Actor | Actor 9 (AI agent), any hurried developer |
| Attack Surface | RLS migrations, `ROUTE_MANIFEST`, `eslint.config.js`, test assertions, `lint-migrations.mjs` |
| Scenario | (a) A failing isolation test is "fixed" by loosening its assertion. (b) A route is marked `public: true` to get past a `401`. (c) A guard is written that matches nothing and passes forever. (d) Two agents edit the same tree and one commits the other's half-finished change |
| Impact | A control silently disappears |
| Likelihood | **Medium, and rising with agent use** |
| Mitigation | Hard rules in `CLAUDE.md` / `AGENTS.md`; every guard seen to fail before it is trusted (`../PLAN/16-TESTING-STRATEGY.md` §1); explicit file lists on commit |
| Detection | Review of any diff touching the paths above. (c) has happened twice: `frontend-boundary.test.ts` matched nothing, and the manifest check was blind to `export function` handlers (`PLAN/13` §4 bug 18) |
| Response | Revert; record in `MEMORY/` |
| Status | **Partial** — relies on review; no CI; no CODEOWNERS |

## 20. Injection

| Field | Detail |
|---|---|
| Asset | All database assets; the worker process |
| Trust Boundary | TB-4, TB-11 |
| Threat Actor | Actor 2, Actor 4 |
| Attack Surface | Raw SQL, salary formulas, spreadsheet exports, tenant context |
| Scenario | (a) SQL through a search parameter. (b) Tenant context injection through `set_config`. (c) A salary formula containing `require('child_process')`. (d) A cell beginning `=HYPERLINK(...)` in an export opened by HR in Excel |
| Impact | Data exposure; code execution in the worker; a phishing link in a trusted file |
| Likelihood | Low |
| Mitigation | (a) `$queryRaw` tagged templates bind parameters; no string-built SQL found. (b) `set_config` bound — tested with an injection string. (c) allowlisted expression parser, no `eval`; `eval`, `require`, `__proto__` refused — 33 cases. (d) export cells written with an explicit string type |
| Detection | Tests |
| Response | — |
| Status | **Mitigated** |

## 21. Cross-Site Request Forgery

| Field | Detail |
|---|---|
| Asset | A-6 |
| Trust Boundary | TB-1 |
| Threat Actor | Actor 4 |
| Attack Surface | Cookie-authenticated endpoints: `/api/auth/refresh`, `/api/auth/logout` |
| Scenario | A page on another site makes the victim's browser call refresh or logout |
| Impact | Forced logout; refresh returns a token to a response the attacking page cannot read |
| Likelihood | Low |
| Mitigation | Every data endpoint requires a bearer token a cross-site page cannot attach. The refresh cookie is `SameSite=Strict` and scoped to `/api/auth` |
| Detection | — |
| Response | — |
| Status | **Mitigated** |

---

## Summary

| § | Scenario | Status |
|---|---|---|
| 1 | Cross-tenant / cross-object access | Mitigated (tenant) · Partial (object) |
| 2 | Authentication attacks | Partial — no MFA |
| 3 | Tokens and sessions | Mitigated · HS256 still verifies |
| **4** | **`X-Forwarded-For` spoofing** | **Open** |
| 5 | Privilege escalation, self-approval | Mitigated |
| 6 | Subscription bypass | Mitigated |
| 7 | Attendance evidence fraud | Partial by design |
| 8 | Personal data exposure | Mitigated · **unmask views not audited** |
| 9 | Control plane | Mitigated |
| 10 | Internal service boundary | Mitigated |
| 11 | File upload | Mitigated |
| 12 | Enumeration | Mitigated · tenant codes accepted |
| 13 | XSS / browser headers | Partial — no CSP |
| 14 | Noisy neighbour | Partial — untested |
| 15 | Location surveillance | Mitigated |
| 16 | Shared device | Mitigated in tests |
| 17 | Audit integrity | Mitigated (application) |
| 18 | Secrets and supply chain | Open — no CI |
| 19 | Guard erosion | Partial |
| 20 | Injection | Mitigated |
| 21 | CSRF | Mitigated |

Every **Open** and **Partial** row has an entry in `TASKS/BACKLOG.md`.
