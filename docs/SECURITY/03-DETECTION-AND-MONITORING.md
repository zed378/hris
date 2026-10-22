# 03 — Detection and Monitoring

How an attack or a failing control becomes visible. `../PLAN/19-OBSERVABILITY.md` describes the signals the system emits; this document says which of them matter for security, what should alert, and — honestly — that **nothing alerts today**.

---

## Detection Layers

| Layer | Source | Exists | Security value |
|---|---|---|---|
| Preventive tests | `tenant-isolation`, `rls-coverage`, `gateway`, `route-manifest`, `service-worker`, `logger`, `formula`, `jwt-signing` suites | Yes — run locally | Catch a control removed by a change, **before** it ships — if someone runs them (no CI) |
| Schema drift | `public.schema_drift_report()`, daily worker job | Yes | A table without RLS, a policy missing, a role able to bypass RLS |
| Audit trail | `audit.audit_logs`, `platform.platform_audit_logs`, `attendance.photo_access_logs` | Yes | Who did what: logins, failures, lockouts, token reuse, role and grant changes, exports, photo access. **Not** unmasked PII views |
| Structured logs | JSON to stdout, redacted, correlation id per request | Yes | Refusals, quota hits, Redis and auth-service outages |
| Metrics | `hrms_http_requests_total{route,status}`, duration histogram | Yes, behind `METRICS_TOKEN` | Rates of `401`, `403`, `429`, `503` per route |
| Readiness facts | `rateLimit`, `signing` in `/api/ready` | Yes | A deployment silently running per-process limits, or unable to sign tokens |
| Trust scoring | Punch flags, review queue, flagged ratio | Yes | Attendance fraud surfaced to a human (P14) |
| Alerting | — | **No** | — |
| Error tracking | — | **No** | — |
| Log retention off-host | — | **No** | An attacker with host access edits the only copy |
| Dependency and secret scanning | — | **No** | — |

## Priority Alerts to Build

Consolidated from the Detection rows of `02-ATTACK-SURFACE-AND-SCENARIOS.md`. None exists; this is the list to build first, in order.

| # | Alert | Signal | Scenario | Severity |
|---|---|---|---|---|
| D-1 | Schema drift finding of any kind | Drift job log `severity: critical` | `02` §1 | **Page** |
| D-2 | Refresh token reuse detected | `auth.token.reuse_detected` audit rows | `02` §3 | **Page** if > 3 / hour across tenants; ticket otherwise |
| D-3 | Failed-login spike | `auth.login.failed` + `auth.login.locked` rate, platform-wide and per tenant | `02` §2 | Page |
| D-4 | Readiness reports `signing: unconfigured` on a container that serves login | `/api/ready` | `02` §3 | Page — every login fails |
| D-5 | Readiness reports `rateLimit: in-process` with > 1 replica | `/api/ready` | `02` §14 | Ticket |
| D-6 | Bulk PII unmask | > N unmasked employee reads by one actor in an hour — **the audit row does not exist yet**; requires `02` §8(e) first | `02` §8 | Ticket to the tenant's owner |
| D-7 | Role or grant change conferring an `iam.*` or `payroll.*` permission | `iam.role.permissions_changed`, grant audit rows | `02` §5 | Notify the tenant's owner |
| D-8 | Superuser login, any | `superuser.login.succeeded` and `superuser.login.failed` (with `detail.reason`) in `platform_audit_logs` since P6-14; no alert wired yet (`P6-16`) | `02` §9 | Notify all superusers |
| D-9 | Auth service unreachable | `503` rate on authenticated routes; auth-client error log | `02` §10 | Page |
| D-10 | `X-Forwarded-For` first entry differs from last on an office-verified punch | New log field — requires the §4 fix's instrumentation | `02` §4 | Ticket |
| D-11 | Photo access by one HR user above a threshold | `photo_access_logs` | `02` §15 | Notify the tenant's owner |
| D-12 | Sustained `429`/`503` for one tenant during 07:00–09:00 | Metrics | `02` §14 | Ticket |

D-6, D-7, and D-11 alert **the tenant**, not the operator. The operator must not read a tenant's audit trail to decide whether HR is misbehaving — that is the tenant's governance, and the product's job is to put the signal in front of the right person.

## Audit Log as a Detection Source

The audit trail answers "who, when, from where" after the fact. Three limits apply:

1. **The address column is client-controlled** until `02` §4 is fixed. Treat it as a claim.
2. **It is append-only against the application, not against the host operator.** An incident involving Actor 7 cannot rely on it without an off-host copy.
3. **No one reviews it on a schedule.** It is consulted when something is already suspected.

## Alert Routing and Ownership

Not decided. There is no on-call rotation, no paging tool, and no named security owner. Recorded as `TASKS/BACKLOG.md` `OQ-06`. Until decided, every "Page" above means "the person operating the deployment, by whatever channel they actually read".

## Review Cadence

| What | How often | By |
|---|---|---|
| `schema_drift_report()` output | Daily (automated run); read weekly until D-1 exists | Operator |
| Superuser actions in `platform_audit_logs` | Weekly | Operator |
| Lockout and token reuse counts | Weekly | Operator |
| `02` scenario statuses | Every gate in `../PLAN/21-ACCEPTANCE-CRITERIA.md`, and after any change to auth, tenancy, or attendance evidence | Whoever owns the change |
| This alert list | When a new scenario is added to `02` | Same |
