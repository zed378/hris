# 22 — Risk Register

The live risk register. `04-Development-Phases-Team-Risk.md` §11 holds the original register (R1–R52), written for a sixteen-service architecture; `14-Service-Split-and-Platform-Evolution.md` §12 holds the split's risks (S1–S8). This document **re-assesses those against the system as built** and adds the risks found since. It is the one to update.

Risk ids are stable: `R` and `S` keep their original numbers; new risks are `N`. A retired risk keeps its row with the reason.

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
| **N1** | **Client-controlled `X-Forwarded-For` defeats per-address rate limits and office-network verification** | **High** | High | None — the first header entry is trusted | Take the address the trusted proxy appended; test with a spoofed header | `SECURITY/02` §4 |
| R1 | Payroll calculations are inaccurate | Medium | **Critical** | Formula allowlist, period-based structures | Statutory components, golden regression, parallel run — Gate C | `12` Phase 5 |
| R9 | A personal data incident under the PDP Act | Low | **Critical** | Encryption, redaction, access audit, retention | No incident playbook rehearsed; no alerting | `SECURITY/04` |
| R18 | Without MFA, one leaked tenant password opens HR data | Medium | High | Lockout, refresh reuse detection | No tenant-user MFA; no new-device notification | `17` §9 |
| **N2** | **No CI: every "CI gate" runs only when someone remembers** | **High** | High | `pnpm verify` locally | A pipeline running `verify`, image builds, dependency audit | `16` §4 |
| **N3** | **No alerting: failures are logged and unseen** | **High** | High | Structured logs, readiness facts, metrics | Alert rules, error tracking, uptime check | `19` §6 |
| **N4** | **Uploaded files and PII keys are outside every backup** | Medium | **Critical** | Volume on the host | Off-host file backup; key escrow procedure | `20` §6–7 |
| R39 / R47 | Mock GPS in a browser; customers believe punching is spoof-proof | High | High | `WEB_UNVERIFIED_DEVICE` penalty, review queue, office network | Office network is bypassable (N1); sales material not written | `10`, `SECURITY/02` |
| **N5** | **No browser security headers (CSP, HSTS, frame-ancestors)** | Medium | High | React escaping | Headers in Next config or the proxy | `17` §9 |
| S1 | HS256 secret still able to mint tokens after the split | Medium | High | EdDSA default; readiness reports `hybrid` | Remove `JWT_SECRET` from every environment; compose example still uses it | `14` §6 |
| R43 | Indoor GPS produces many false flags | High | Medium | Per-tenant accuracy threshold, office network | Office network bypassable (N1); unmeasured on devices | `10` |
| R48 | Offline queue lost on iOS eviction | Medium | High | `storage.persist()`, warning | Not tested on a real iPhone | `11` |
| **N6** | **No mobile navigation: the sidebar is hidden below `md` and nothing replaces it** | **High** | Medium | PWA shortcuts to punch and my attendance; home dashboard cards link onward | A mobile navigation pattern; a way back home from every page | `UI-UX/09` |
| **N7** | **Concurrent AI agents editing the same working tree** | Medium | Medium | Explicit file lists on commit | A worktree-per-agent rule | `MEMORY/records/2026-09-13-concurrent-agent-commits.md` |
| **N8** | **API documentation drifts: 14 of 100 routes documented, and a comment claims a coverage test that does not exist** | High | Medium | Generator derives paths from the manifest | The coverage test | `15` §9 |
| S3 | Auth service as a single point of failure | Medium | High | Opt-in; `503` never a fallback; permission cache | Degraded mode not load-tested | `14` §10.6 |
| R41 | Employees refuse permissions because they feel surveilled | Medium | High | Consent screen, no background location, no coordinates on the dashboard | No usability testing with real employees | `10` |
| **N9** | **No capacity assumptions exist, so nothing can be sized or load-tested** | Medium | Medium | — | `TASKS/BACKLOG.md` `OQ-05` | `18` §5 |
| S6 | Logs shipped abroad carry PII | Medium | **Critical** | Redaction tested; logs not shipped | Decide the vendor with legal first | `14` §9.3 |
| R17 | A noisy tenant degrades others | Medium | High | Per-tenant quota, statement timeouts | Not load-tested | `18` |
| R26 | Breadth before depth | High | High | Five-module shortlist | Four modules built with no design-partner usage recorded in this repository | `12` §4 |
| **N11** | **Viewing unmasked PII in the employee list or detail is not audited** — only exports are | Medium | High | Permission required; export audited | Audit row per unmasked read; `12` Phase 2 DoD | `SECURITY/02` §8 |
| **N12** | **No permission ceiling: role and grant administrators can confer any permission, including on themselves** | Low | High | Audited; access version bumps | "Cannot grant what you do not hold" | `SECURITY/02` §5 |
| **N13** | **Superuser TOTP secrets stored in plaintext; superuser logins not audited** | Low | High | `hrms_platform` has no tenant-data grant | Encrypt with the key ring; audit logins | `SECURITY/02` §9 |
| **N10** | **The language of API error messages is contested** | Medium | Low | — | `TASKS/BACKLOG.md` `OQ-01` | `15` §11 |
| R2 | Tax and BPJS regulations change | High | Medium | `statutory_configs` versioned by date range | Tables exist; components do not | `07` |
| R6 | The UI feels harder than Excel | High | High | AG Grid, `.xlsx` export, import pipeline | No usability testing | `UI-UX/` |
| R52 | Web Push does not arrive on iOS | High | Medium | Push → email tiering | WhatsApp not built | `11` |

## 3. Controlled — Watch, Don't Work

| # | Risk | Why controlled | What would reopen it |
|---|---|---|---|
| R4 | Cross-tenant data leak | FORCE RLS, `NOBYPASSRLS`, composite FKs, per-tenant channels, tests | A new table without RLS; a runtime role granted ownership |
| R15 | `X-Tenant-ID` trusted without the token | Header only confirms; `TENANT_MISMATCH` test | A route not going through `defineRoute` |
| R16 / S2 | Stale entitlement or permission cache | Access version in the key; tenant generation | Caching keyed without the version |
| R19 | Accidental tenant purge | No purge path exists | Building one |
| R20 | Superuser credentials leak | Mandatory TOTP by constraint; no grant on tenant data | A grant added "for support" |
| R21 | `BYPASSRLS` added for convenience | Re-asserted per deploy; tested | Any exception, ever |
| R33 | A migration locks a hot table | `lock_timeout`, online runner, migration lint | Hand-run DDL |
| R37 | Manual schema change | Daily drift report | Nobody reading its output (N3) |
| R50 | Shared-device cache leak | Service worker caches no API or credential path | Caching an API response "for offline" |
| S4 | Rate limits multiplied by replicas | Redis-backed, reported in readiness | Redis unset in a multi-replica deploy |

## 4. Retired

| # | Risk | Why retired |
|---|---|---|
| R10–R14 | Distributed-architecture risks: wrong service boundaries, replica drift, saga compensation, operational load of 16 services, cascading failure | The modular monolith (`12`) does not have them. They return only if services are split beyond auth |
| R29 | Service count exceeds capacity | Same |
| R22 | PII in `platform_db` | One database with `hrms_platform` grants tested instead |
| S5 | Stalling half-migrated | Stages 1–8 are each independently valuable and complete through stage 7 |

## 5. How to Use This Register

- A task that changes a risk's probability or control updates its row in the same change.
- A new risk found during work gets an `N` id here **and** an entry in `TASKS/BACKLOG.md` if it needs work.
- Reviewed at every gate in `21-ACCEPTANCE-CRITERIA.md` §2. A gate does not open over an open **Critical** risk without a written acceptance in `MEMORY/DECISIONS.md`.
