# 05 — Verification and Red Team Plan

How each scenario in `02-ATTACK-SURFACE-AND-SCENARIOS.md` is shown to be mitigated — by an automated test, a structural guard, or a manual exercise — and what "verified" is allowed to mean.

---

## Scope

All verification in this plan is performed **only** against environments of this system that the team owns: a local development stack, a disposable Compose stack, or a staging environment created for the purpose. **Never** against a production environment holding real tenant data without written approval from the tenants affected, and never against third-party systems — including the email and push providers the system calls.

Test tenants are created fresh with random identifiers and deleted afterwards (`../PLAN/16-TESTING-STRATEGY.md` §1).

## Verification Per Scenario

| `02` § | Scenario | Automated verification | State | Manual exercise |
|---|---|---|---|---|
| 1 | Cross-tenant access | `tenant-isolation.test.ts`, `rls-coverage.test.ts`, `gateway.test.ts` (`TENANT_MISMATCH`) | **Exists** | Two tenants on a running stack; replay every list and `[id]` request from tenant A with tenant B's token |
| 1(c) | Cross-object within a tenant | Per-route ownership tests — photo route only | **Gap**: no structural check that every `[id]` route verifies ownership | Replay every `[id]` route as a second employee of the same tenant |
| 2 | Authentication | None for lockout or equal timing; forgot-password `204` in `apps/auth/test/service.test.ts` | **Gap** | Scripted login attempts against a test tenant; confirm lockout and `retry-after` |
| 3 | Tokens | `jwt-signing.test.ts` (`alg: none`, HS256 with public key), access version in `authorize.test.ts`, reuse detection | Exists | Present an admin token to `/api/*` and a tenant token to `/admin/api/*` |
| **4** | **`X-Forwarded-For` spoofing** | **None** | **Gap — write first** | Send a spoofed header through the reference nginx and confirm which address reaches `recordPunch` and the rate limiter |
| 5 | Escalation, self-approval | Approver-permission holders in `leave-approver.test.ts`; DENY precedence in `gateway.test.ts`. **No self-approval test** | Partial | As a role administrator, add a payroll permission to your own role; confirm it is audited (and, once built, refused) |
| 6 | Subscription bypass | `gateway.test.ts` (`402` before `403`) | Exists | Call an unsubscribed module's endpoints directly |
| 7 | Attendance evidence | `trust.test.ts`, `office-network.test.ts` | Exists for scoring | Browser DevTools location override on a test tenant; confirm `WEB_UNVERIFIED_DEVICE` and review-queue entry |
| 8 | PII exposure | `logger.test.ts`, `pii.test.ts`, `pii-rotation.test.ts`, `import-pii.test.ts` | Exists, except unmask auditing | Export as a user without unmask; grep the file for unmasked national IDs; open an employee detail with unmask and confirm an audit row (**currently none**) |
| 9 | Control plane | `rls-coverage.test.ts` grant matrix for `hrms_platform` | Exists | As a superuser, attempt every tenant data read through `psql` as `hrms_platform` |
| 10 | Internal boundary | `apps/auth/test/service.test.ts` (secret guard, `404`) | Exists | Request `/internal/authorize` through the proxy from outside |
| 11 | File upload | `sniffType` magic-byte tests in `documents.test.ts`; EXIF stripping in `photo.test.ts` | Exists | Upload an HTML file renamed `.pdf`; upload a photo with GPS EXIF and inspect the stored file |
| 12 | Enumeration | Forgot-password `204` in `service.test.ts`; no timing test | Partial | Compare login timing for an unknown tenant versus a wrong password |
| 13 | XSS / headers | None | **Gap** | Inspect response headers; place a script payload in every free-text field and view it as HR |
| 14 | Noisy neighbour | Quota tests in `packages/cache/test` | Partial | Load test per `../PLAN/18-PERFORMANCE-AND-CAPACITY.md` §6 — not run |
| 15 | Location surveillance | Live-event payload has no coordinates | Exists | Inspect the SSE stream |
| 16 | Shared device | `service-worker.test.ts` | Exists | Two accounts on one physical phone; log out; inspect Cache Storage and IndexedDB |
| 17 | Audit integrity | `tenant-isolation.test.ts` (update/delete refused) | Exists | — |
| 18 | Secrets / supply chain | None | **Gap** | `pnpm audit`; a secret scanner over git history |
| 19 | Guard erosion | Each guard's deliberate-violation run, recorded in `MEMORY/` | Partial | Break each guard once per quarter; confirm it fails |
| 20 | Injection | `formula.test.ts`, the `set_config` injection test | Exists | — |
| 21 | CSRF | Cookie attributes in `service.test.ts` | Exists | Cross-origin form post to `/api/auth/refresh` |

## Order of Work

1. **`02` §4** — the only **Open** scenario with a High likelihood and a known fix. Test first, then the fix.
2. **`02` §13** — security headers. Cheap, and they contain every future XSS.
3. **`02` §8(e)** — audit unmasked PII reads in the list and detail views, as `12` Phase 2 DoD requires.
4. **`02` §1(c)** — a structural test that every `[id]` route has an ownership check or an `all`-scoped permission.
5. **`02` §18** — CI with `pnpm audit` and secret scanning (depends on CI existing at all).
6. **`02` §5(a)** — a permission ceiling for role and grant administrators.
7. **`02` §9(c)** — encrypt superuser TOTP secrets with the PII key ring.

## External Penetration Testing

Before Gate D in `../PLAN/21-ACCEPTANCE-CRITERIA.md` — paid general availability — an external penetration test of a staging environment, scoped to the tenant plane, control plane, auth service, and PWA. Not before: the findings above are known, and paying someone to find them again is waste.

## Cadence

| Activity | When |
|---|---|
| Automated suites | Every change (locally until CI exists) |
| Manual exercises for scenarios a change touches | Before the change is marked done |
| Full manual pass over this table | Before each gate |
| Guard deliberate-violation pass | Quarterly |
| External penetration test | Before paid GA, then yearly |

## Definition of "Verified"

A scenario is **verified** only when all of these hold:

1. A test or recorded manual exercise **attempts the attack** — not only the happy path.
2. It was **seen to fail** against code without the mitigation (or the manual exercise succeeded before the fix and failed after).
3. It exercises the **real request path** — through the gateway handler with a real `Request`, not only the inner function. §4 survived precisely because its inner function was well tested and the header parsing in front of it was not.
4. The result is recorded in `MEMORY/records/` with the date, environment, and outcome.

A green suite that never attempted the attack verifies nothing about it.
