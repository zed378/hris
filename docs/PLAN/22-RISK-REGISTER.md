# 22 — Risk Register

The live risk register. `04-Development-Phases.md` §11 holds the original register (R1–R52), written for a sixteen-service architecture; `12-Small-Team-Execution-Plan.md` §10.3 holds the modular monolith's risks (N1–N7); `14-Service-Split-and-Platform-Evolution.md` §12 holds the split's risks (S1–S8). This document **re-assesses those against the system as built** and adds the risks found since. It is the one to update.

Risk ids are stable: `R`, `N`, and `S` keep their original numbers; risks found while writing these documents on 2026-09-13 are `F`. A retired risk keeps its row with the reason.

Assessed 2026-09-13.

---

## 1. Scale

| Probability | Meaning | Impact | Meaning |
|---|---|---|---|
| Low | Would need an unusual event | Medium | A tenant is inconvenienced; recoverable |
| Medium | Plausible within a year | High | A tenant's data or pay is wrong, or a tenant is locked out |
| High | Expected without action | **Critical** | Cross-tenant exposure, wrong pay at scale, or legal breach |

## 2. Open Risks — Highest First

| # | Risk | Prob. | Impact | Current control | Gap | Owner doc |
|---|---|---|---|---|---|---|
| **F1** | **Client-controlled `X-Forwarded-For` defeats per-address rate limits and office-network verification** | **High** | High | `clientAddress()` reads only `X-Real-IP` when `TRUST_PROXY=true`; otherwise `unknown` | — | `SECURITY/02` §4 |
| R1 | Payroll calculations are inaccurate | Medium | **Critical** | Formula allowlist, period-based structures | Statutory components, golden regression, parallel run — Gate C | `12` Phase 5 |
| R9 | A personal data incident under the PDP Act | Low | **Critical** | Encryption, redaction, access audit, retention | No incident playbook rehearsed; no alerting | `SECURITY/04` |
| R18 | Without MFA, one leaked tenant password opens HR data | Medium | High | Lockout, refresh reuse detection | No tenant-user MFA; no new-device notification | `17` §9 |
| **F3** | **No alerting: failures are logged and unseen** | **High** | High | Structured logs, readiness facts, metrics | Alert rules, error tracking, uptime check | `19` §6 |
| **F4** | **Every backup lives on the database host, and the PII keys are in no backup at all** | Medium | **Critical** | Daily dump + storage archive + WAL, on host volumes | Off-host copies; a key escrow procedure | `20` §6–7 |
| R39 / R47 | Mock GPS in a browser; customers believe punching is spoof-proof | High | High | `WEB_UNVERIFIED_DEVICE` penalty, review queue, office network | Office network is bypassable (F1); sales material not written | `10`, `SECURITY/02` |
| **F5** | **No browser security headers (CSP, HSTS, frame-ancestors)** | Medium | High | React escaping | **Mitigated** — `apps/web/next.config.ts` `headers()` sets CSP (`'self'` only; inline script still allowed), X-Content-Type-Options, X-Frame-Options `DENY`, Referrer-Policy, HSTS; `apps/web/test/security-headers.test.ts` | `17` §9 |
| S1 | ~~HS256 secret still able to mint tokens after the split~~ | — | — | **Closed** — HS256 removed from code (PS-08, ADR-038); `jwt-signing.test.ts` refuses HS256 tokens with the secrets still set | — | `14` §6 |
| R43 | Indoor GPS produces many false flags | High | Medium | Per-tenant accuracy threshold, office network | Office network bypassable (F1); unmeasured on devices | `10` |
| R48 | Offline queue lost on iOS eviction | Medium | High | `storage.persist()`, warning | Not tested on a real iPhone | `11` |
| **F6** | **No mobile navigation: the sidebar is hidden below `md` and nothing replaces it** | **High** | Medium | PWA shortcuts to punch and my attendance; home dashboard cards link onward | **Mitigated** — bottom bar and drawer below `md` (`PF-02`), tenant name links home; `apps/web/test/mobile-menu.test.ts`. Real-device check pending (`P3-15`) | `UI-UX/09` |
| **F7** | **Concurrent AI agents editing the same working tree** | Medium | Medium | Explicit file lists on commit | A worktree-per-agent rule | `MEMORY/records/2026-09-13-concurrent-agent-commits.md` |
| **F8** | ~~14 of 100 routes documented, and a comment claims a coverage test that does not exist~~ — **Mitigated** | ~~High~~ | ~~Medium~~ | Generator derives paths from the manifest | The coverage test | `15` §9 |
| R41 | Employees refuse permissions because they feel surveilled | Medium | High | Consent screen, no background location, no coordinates on the dashboard | No usability testing with real employees | `10` |
| S6 | Logs shipped abroad carry PII | Medium | **Critical** | Redaction tested; logs not shipped | Decide the vendor with legal first | `14` §9.3 |
| R17 | A noisy tenant degrades others | Low | High | Per-tenant quota, statement timeouts; 3 tenants in year one (ADR-033) | Not load-tested | `18` |
| R26 | Breadth before depth | High | High | Five-module shortlist | Four modules built with no design-partner usage recorded in this repository | `12` §4 |
| **F11** | **Viewing unmasked PII in the employee list or detail is not audited** — only exports are | Medium | High | Permission required; export audited | Audit row per unmasked read; `12` Phase 2 DoD | `SECURITY/02` §8 |
| **F12** | **No permission ceiling: role and grant administrators can confer any permission, including on themselves** | Low | High | Audited; access version bumps | **Mitigated** — `packages/core/src/iam/ceiling.ts` (ADR-035); `apps/web/test/permission-ceiling.test.ts` | `SECURITY/02` §5 |
| **F13** | **Superuser TOTP secrets stored in plaintext; superuser logins not audited** | Low | High | `hrms_platform` has no tenant-data grant | **Mitigated** — sealed under `PLATFORM_ENCRYPTION_KEY`; logins in `platform_audit_logs` (P6-14) | `SECURITY/02` §9 |
| **F10** | **Users see English server messages** — backend English by decision, frontend not yet mapping codes | High | Low | — | `P6-24`, `PF-20` (ADR-030) | `15` §11 |
| R2 | Tax and BPJS regulations change | High | Medium | `statutory_configs` versioned by date range | Tables exist; components do not | `02`, `12` Phase 5 |
| R6 | The UI feels harder than Excel | High | High | AG Grid, `.xlsx` export, import pipeline | No usability testing | `UI-UX/` |
| R52 | Web Push does not arrive on iOS | High | Medium | Push → email tiering | WhatsApp not built | `11` |

### From `12` §10.3

| # | Risk | Prob. | Impact | Current control | Gap |
|---|---|---|---|---|---|
| N1 | Module boundaries dissolve | High | High | `eslint-plugin-boundaries`; `frontend-boundary.test.ts` | Enforced only locally — no CI (F2) |
| N2 | One bug takes down the whole system | Medium | High | Worker separate from web; `statement_timeout`; overload answers `503` | Rollback time not measured |
| N3 | Bus factor of 1–2 people | High | **Critical** | Comments explain *why*; ADRs; runbook; these documents | Several ADRs are reconstructed after the fact (`MEMORY/DECISIONS.md`) |
| N4 | Payroll built without a domain expert | High | **Critical** | Statutory calculation not built | **Gate C deviated**: the payroll framework was built ahead of the gate (`MEMORY/DECISIONS.md`) |
| N5 | Running out of energy or money before the first customer | High | **Critical** | Gates A and B | **Phases 3–6 built without Gates A or B met** |
| N6 | A large customer bends the roadmap | High | High | §4.5 waiting-list rule | No customer yet |
| N7 | pg-boss becomes a bottleneck at peak | Low | Medium | NATS broker opt-in; first-year peak ≤ 600 punches (ADR-033) | Never measured at peak volume — far below its limits at this envelope |

## 3. Controlled — Watch, Don't Work

| # | Risk | Why controlled | What would reopen it |
|---|---|---|---|
| R4 | Cross-tenant data leak | FORCE RLS, `NOBYPASSRLS`, composite FKs, per-tenant channels, tests | A new table without RLS; a runtime role granted ownership |
| **F2** | **CI gates run only when someone remembers** | GitHub Actions pipeline (`.github/workflows/ci.yml`): `pnpm verify` against real PostgreSQL and Redis, the broker suite over NATS, `pnpm audit`, gitleaks, and the three image builds (`P0-09`, 2026-10-21) | Branch protection on `main` not yet configured — an operator action in GitHub settings, not code |
| R15 | `X-Tenant-ID` trusted without the token | Header only confirms; `TENANT_MISMATCH` test | A route not going through `defineRoute` |
| R16 / S2 | Stale entitlement or permission cache | Access version in the key; tenant generation | Caching keyed without the version |
| R19 | Accidental tenant purge | No purge path exists | Building one |
| R20 | Superuser credentials leak | Mandatory TOTP by constraint; no grant on tenant data | A grant added "for support" |
| R21 | `BYPASSRLS` added for convenience | Re-asserted per deploy; tested | Any exception, ever |
| R33 | A migration locks a hot table | `lock_timeout`, online runner, migration lint | Hand-run DDL |
| R37 | Manual schema change | Daily drift report | Nobody reading its output (F3) |
| R50 | Shared-device cache leak | Service worker caches no API or credential path | Caching an API response "for offline" |
| S4 | Rate limits multiplied by replicas | Redis-backed, reported in readiness | Redis unset in a multi-replica deploy |

## 4. Retired

| # | Risk | Why retired |
|---|---|---|
| R10–R14 | Distributed-architecture risks: wrong service boundaries, replica drift, saga compensation, operational load of 16 services, cascading failure | The modular monolith (`12`) does not have them. They return only if services are split beyond auth |
| R29 | Service count exceeds capacity | Same |
| R22 | PII in `platform_db` | One database with `hrms_platform` grants tested instead |
| S5 | Stalling half-migrated | Stages 1–8 are each independently valuable and complete through stage 7 |
| S3 | Auth service as a single point of failure | The auth service is not enabled; authorization stays in-process (ADR-032). Reopens if SSO is adopted (`DF-11`) |
| F9 | No capacity assumptions | Stated 2026-09-14: 3 tenants, ≤ 600 employees in year one (ADR-033) |
| S8 | The split is premature | Decided 2026-09-14: SSO not now, no public API — the split stops, per `14` §12 S8's own recommendation (ADR-032) |

## 5. How to Use This Register

- A task that changes a risk's probability or control updates its row in the same change.
- A new risk found during work gets an `N` id here **and** an entry in `TASKS/BACKLOG.md` if it needs work.
- Reviewed at every gate in `21-ACCEPTANCE-CRITERIA.md` §2. A gate does not open over an open **Critical** risk without a written acceptance in `MEMORY/DECISIONS.md`.
