# 23 — Feature Specification Template

The structure every non-trivial feature is specified in **before** implementation. Copy the template into `MEMORY/specs/<task-id>-<slug>.md`, fill every section, and have it reviewed. A section that does not apply says **"Not applicable — because …"**; an empty section is not a finished spec.

A spec is mandatory for any change touching: authentication, authorization, tenant isolation, personal data, attendance evidence, payroll, money, or the data model. `TASKS/00-TASK-CONVENTIONS.md` §5 says when else.

---

## Template

```markdown
# <Task id> — <Feature name>

Status: Draft | Reviewed | Superseded
Task: TASKS/PHASE-<n>.md <task id>
Plan refs: docs/PLAN/NN §x, docs/UI-UX/NN, docs/SECURITY/02 §x

## 1. Business Objective
What problem, for whom, and how we know it is solved. One paragraph.

## 2. Actors
Personas from docs/UI-UX/01, plus any system actor (worker job, device import, superuser).

## 3. Functional Requirements
Numbered, testable. "The system shall …".

## 4. Non-Functional Requirements
Latency, volume, offline behaviour, retention. Cite docs/PLAN/18 targets.

## 5. Dependencies
Tasks, modules, subscriptions, environment variables, external services.

## 6. Database Changes
Tables, columns, indexes, RLS policy, composite tenant FKs. Additive only (P12).
Online migration needed? Why?

## 7. API Contract
Route ids exactly as they will appear in ROUTE_MANIFEST, with module, permission,
rate limit, request and response schemas, and every error code (docs/PLAN/15 §6).

## 8. Frontend Changes
Pages, components, menu entries, states (docs/UI-UX/11), copy (docs/UI-UX/13).

## 9. Backend Changes
Which module in packages/core, which public exports through index.ts.

## 10. Authorization Rules
Who may, who may not, and the refusal each gets. Subscription (402) before
permission (403). Own / team / all scopes.

## 11. Validation
Every input, its schema, its bounds. Both sides of each boundary.

## 12. Error Handling
What the user sees for each failure, and what is logged.

## 13. Edge Cases
Timezones (WIB/WITA/WIT), offline replay, concurrent requests, empty tenants,
unconfigured settings, a module unsubscribed mid-flow.

## 14. Abuse Cases
Scenario ids from docs/SECURITY/02 this feature must be tested against, plus any
new scenario it introduces (add it to docs/SECURITY/02 in the same change).

## 15. Logging and Audit
What goes to audit.audit_logs, what goes to structured logs, what must NOT be
logged (PII, tokens, coordinates).

## 16. Security Controls
The controls from docs/PLAN/17 this feature relies on, and any new one.

## 17. Testing Strategy
Unit, integration against real services, structural guard, running-app proof.
No mocks (docs/PLAN/16 §1). Which test would fail if the feature broke silently?

## 18. Acceptance Criteria
Checkable statements, each with its verification method (docs/PLAN/21).

## 19. Definition of Done
The task's DoD plus TASKS/00-TASK-CONVENTIONS.md global DoD.

## 20. Implementation Sequence
Ordered steps, each leaving the system working.

## 21. Rollback Strategy
What happens to data written by the feature if the code is reverted. Migrations
are never reversed — say what the previous image does with the new columns.

## 22. Technical Risks
Risk ids from docs/PLAN/22, and any new one.
```

---

## Worked Example: Office Network Verification

Applied retrospectively to a feature that exists (`packages/core/src/attendance/office-network.ts`, migration `20260901090000_work_site_networks`). It was built **without** this template — and filling section 14 honestly surfaces the defect that shipped. That is the point of the example.

| Section | Content |
|---|---|
| 1. Business Objective | A browser cannot detect mock GPS (R47). Give tenants one signal a browser cannot forge — the network a request arrives from — so a punch from the office is not penalised as unverified, and so `FALLBACK_ONLY` finally does something: it had been stored and offered on screen while behaving exactly like `ALLOW_FLAGGED` |
| 2. Actors | HR administrator configuring work sites; employee punching from a browser; attendance machine import and manual correction (exempt) |
| 3. Functional Requirements | FR1 a work site holds zero or more CIDR ranges. FR2 a web punch from a configured range sets `officeIpVerified`, which removes the `WEB_UNVERIFIED_DEVICE` penalty but never scores above baseline. FR3 under `FALLBACK_ONLY`, a web punch **missing required evidence** is refused unless it comes from a configured range. FR4 a punch carrying its evidence is unaffected. FR5 a tenant with no ranges configured degrades to `ALLOW_FLAGGED` |
| 4. Non-Functional | One query per punch; no measurable latency at the morning peak (`18` §6). Must never turn a malformed proxy header into a failed punch |
| 5. Dependencies | Attendance module; work sites; attendance policy; the reverse proxy's forwarding headers |
| 6. Database Changes | `attendance.work_sites.ip_ranges INET[] NOT NULL DEFAULT '{}'` — `INET[]`, not `TEXT[]`, so PostgreSQL's `<<=` handles netmasks and IPv6 and refuses malformed ranges at write time. Catalogue-only change; no online migration |
| 7. API Contract | `POST /api/attendance/work-sites`, `PATCH /api/attendance/work-sites/[id]` — `attendance.shift.manage`; body gains `ipRanges` (`ipRangesSchema`). `POST /api/attendance/punch` unchanged in shape; refusal is the existing blocked-punch error |
| 8. Frontend Changes | Network ranges on the work site form; the policy screen states that an unconfigured network list degrades `FALLBACK_ONLY` |
| 9. Backend Changes | `checkOfficeNetwork()` and `normaliseClientIp()` in `attendance/office-network.ts`; called from `recordPunch()`; `officeIpVerified` input to `assessTrust()` |
| 10. Authorization Rules | Only `attendance.shift.manage` edits ranges. Ranges are tenant data under RLS; the check runs inside `withTenant` |
| 11. Validation | Each range a valid CIDR (`apps/web/src/lib/cidr.ts`). The client address normalised: IPv4-mapped IPv6 → IPv4, zone index stripped, anything `isIP` rejects → `null` → "no match" |
| 12. Error Handling | Refused punch: an Indonesian message naming the missing evidence and four ways forward (office network, browser permission, attendance machine, HR correction). An unparseable address costs a match, never a punch |
| 13. Edge Cases | Dual-stack listener reporting `::ffff:` addresses; a port suffix; three branches with three networks (ranges live on the site, not the tenant); a VPN back to the office (satisfies the check — it proves the connection, not presence) |
| **14. Abuse Cases** | **An employee sends `X-Forwarded-For: <office address>` from home.** The gateway takes the *first* entry of that header; the reference nginx *appends* the real address after it. The spoofed address is checked, matches, removes the penalty, and satisfies `FALLBACK_ONLY`. **Not tested when built; open today** — `SECURITY/02` §4, `TASKS/BACKLOG.md`, risk `F1` |
| 15. Logging and Audit | Range changes audited on the work site. The client address is not logged per punch beyond the punch row |
| 16. Security Controls | RLS on work sites; parameterised `$queryRaw`; address validated before the `::inet` cast. **Missing:** a trusted-proxy rule for the client address |
| 17. Testing Strategy | `office-network.test.ts` (pure: address normalisation including an injection string; the trust score removing the penalty without adding score); `cidr.test.ts`. **Missing:** `checkOfficeNetwork` against real PostgreSQL (containment, IPv6, unconfigured tenant), and a gateway-level test sending a spoofed header through the real handler |
| 18. Acceptance Criteria | Off-network punch without location refused under `FALLBACK_ONLY`; on-network accepted; unconfigured tenant accepted and flagged; **spoofed header refused** |
| 19. Definition of Done | Global DoD + the four criteria above passing — the fourth would have held the task open |
| 20. Implementation Sequence | Migration → `normaliseClientIp` + tests → `checkOfficeNetwork` + tests → punch integration → trust score input → work site API and form → policy screen copy → **trusted client address in `define-route.ts` + spoof test** |
| 21. Rollback Strategy | The previous image ignores `ip_ranges`; `FALLBACK_ONLY` reverts to its old no-op. No data loss |
| 22. Technical Risks | R47, R43, **F1** |

---

## Reviewing a Spec

A reviewer checks, at minimum:

1. Section 7 route ids are exactly what will be registered, and each has a permission.
2. Section 10 says what an **unsubscribed** tenant sees, not only an unauthorized user.
3. Section 13 mentions time zones for anything with a date, and offline replay for anything a phone sends.
4. Section 14 names at least one scenario, and a test in section 17 exercises it **through the real handler**, not only the inner function.
5. Section 17 answers "which test fails if this breaks silently?"
6. Section 21 does not reverse a migration.
