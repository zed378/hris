# 01 — Threat Actor Profiles

Who realistically attacks an HR system for Indonesian SMEs, what they want, and what they already have. The most likely attacker of this system is not a stranger on the internet — it is **an employee who wants to be paid for a day they did not work**. Profiles are ordered by how often they will actually show up.

---

## Actor 1: The Employee Gaming Attendance

| | |
|---|---|
| Access | A valid tenant account with `own` permissions; the browser's developer tools; a VPN; a colleague's phone |
| Goal | Clock in without being at the site, or at a different time; cover for a late colleague ("buddy punching") |
| Capability | Low technical skill, **high motivation, daily repetition**. Mock GPS in a browser is DevTools → Sensors. Tutorials circulate |
| Targets | A-3, TB-9, **TB-2** |
| Relevant scenarios | `02` §4 (client address spoofing), §7 (attendance evidence fraud) |
| Posture | The system does not claim to stop this actor (R39, R47). It claims to **score and surface** their punches for a human. A control that silently lets them score as verified — §4 — is worse than no control, because HR stops looking |

## Actor 2: The Curious or Resentful Colleague

| | |
|---|---|
| Access | A valid account in the same tenant, sometimes with a manager or HR role |
| Goal | See colleagues' salaries, national IDs, medical leave reasons, or where someone was |
| Capability | Uses the UI and edits URLs and request bodies; may copy a request from the browser's network tab |
| Targets | A-1, A-3, A-4, A-5 |
| Relevant scenarios | `02` §1 (object access within a tenant), §5 (privilege escalation and self-approval), §8 (personal data exposure) |

## Actor 3: The HR Insider Misusing Legitimate Access

| | |
|---|---|
| Access | `employee.pii.unmask`, photo access, the review queue, payroll permissions — legitimately |
| Goal | Track an employee's movements, extract PII, alter pay, approve their own leave |
| Capability | Everything the role allows. Knows the audit trail exists |
| Targets | A-1, A-3, A-4, A-12 |
| Relevant scenarios | `02` §5, §8, §15 (location surveillance), §17 (audit integrity) |
| Posture | Controls are **accountability**, not prevention: photo access and exports are audited, self-approval is refused without exception, coordinates never reach the live dashboard (P15). **Gap:** viewing unmasked PII in the employee list or detail leaves no audit row (`02` §8) |

## Actor 4: The Anonymous External Attacker

| | |
|---|---|
| Access | The public endpoints: login, tenant registration, password reset, invitation acceptance, JWKS, health |
| Goal | Account takeover for data or ransom; enumerating tenants; abusing free trials |
| Capability | Automated: credential stuffing with breached password lists, distributed addresses |
| Targets | A-6, A-13 |
| Relevant scenarios | `02` §2 (authentication), §4 (rate-limit bypass), §12 (enumeration), §13 (XSS and browser headers) |

## Actor 5: A Compromised Tenant Account

| | |
|---|---|
| Access | A real user's session, obtained by phishing, a reused password, or a shared device |
| Goal | Whatever that user can reach — worst case an HR administrator's full tenant |
| Capability | Indistinguishable from the user until behaviour differs |
| Targets | Everything the victim's role reaches |
| Relevant scenarios | `02` §2, §3 (tokens and sessions), §16 (shared device) |
| Posture | No tenant-user MFA exists (R18). Refresh token reuse detection catches a stolen refresh token used alongside the real one, not a stolen password |

## Actor 6: Another Tenant

| | |
|---|---|
| Access | A fully legitimate account in a different tenant; free to register |
| Goal | Read a competitor's employee list or salaries; or simply stumble into another tenant's data through a bug |
| Capability | Can register as many tenants as rate limits allow; can craft any request |
| Targets | TB-5 — every tenant-scoped asset |
| Relevant scenarios | `02` §1 (cross-tenant access), §6 (subscription bypass), §14 (noisy neighbour) |
| Posture | The **Critical** actor. One cross-tenant row ends the product (R4). This is what RLS `FORCE` and fail-closed tenant context exist for |

## Actor 7: The Malicious or Careless Operator

| | |
|---|---|
| Access | The host: environment files (A-7, A-8, A-14), backups (A-15), `psql` as owner, `docker compose` |
| Goal | Deliberate: extract data. Careless: grant `BYPASSRLS` "to make support easier" (R21); commit a secret; leave backups on the same host |
| Capability | Total |
| Targets | Everything |
| Relevant scenarios | `02` §9 (control plane), §18 (secrets and supply chain) |
| Posture | Cannot be prevented by the application. Limited by: runtime roles re-asserted `NOBYPASSRLS` every deploy, daily drift detection, superusers holding no grant on tenant data |

## Actor 8: The Supply-Chain Attacker

| | |
|---|---|
| Access | A compromised npm package in the dependency tree, or a compromised base image |
| Goal | Code execution inside `web`, `auth`, or `worker` — which hold A-7 and A-8 |
| Capability | High, indirect |
| Targets | A-7, A-8, TB-12 |
| Relevant scenarios | `02` §18 |
| Posture | `pnpm-lock.yaml` pins versions. **No automated dependency audit runs** — there is no CI (N2) |

## Actor 9: An AI Coding Agent Working in This Repository

| | |
|---|---|
| Access | The working tree, the shell, the local database; sometimes commit rights |
| Goal | None — but it will complete the task it was given, and may weaken a guard to do so |
| Capability | Fast, confident, and prone to "fixing" a failing security test by changing the test |
| Targets | Guards: RLS migrations, `ROUTE_MANIFEST`, lint rules, test assertions |
| Relevant scenarios | `02` §19 (guard erosion) |
| Posture | `CLAUDE.md` and `AGENTS.md` hard rules; the rule that a guard is never loosened to make a build pass; review of every change to `packages/db/prisma/migrations`, `route-manifest.ts`, `eslint.config.js`. See `MEMORY/records/2026-09-13-concurrent-agent-commits.md` for a real incident |

## How to Use This Document

When writing section 14 of a feature spec, walk the actors top to bottom and ask what each would do with the feature. Actor 1 and Actor 6 are the two most often forgotten: the first because the feature "is not a security feature", the second because every test was run inside one tenant.
