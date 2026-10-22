# 19 — Observability

What the system tells an operator about itself, where it says it, and what it does not say at all. `01-Architecture-Tech-Stack.md` §7 describes the blueprint for sixteen services; this document describes what exists for the modular monolith and its opt-in auth service.

The principle carried through every signal below: **absence is not health.** A counter that never increments, a log line that never appears, and a channel with no listeners all look identical to "nothing is wrong."

---

## 1. Logs

| Property | Implementation |
|---|---|
| Format | JSON, one object per line: `ts`, `level`, `scope`, then fields |
| Library | `packages/observability/src/logger.ts` — the only logger; `no-console` is a lint error outside tests and scripts |
| Redaction | National IDs, bank accounts, passwords, and bearer tokens are removed **before** the line is written; proven with an error carrying all four (`logger.test.ts`) |
| Correlation | `runWithContext` (AsyncLocalStorage) attaches `correlationId` and `routeId` to every line inside a request, without threading them through domain functions |
| Across processes | HTTP `x-correlation-id` → `outbox.correlation_id` column → the worker's log line in a different process, the same value (`13` §3) |
| Across services | The backend forwards `x-correlation-id` to the auth service, which echoes it (`apps/web/src/lib/auth-client.ts`) |

Log levels carry meaning: an expected refusal — a wrong password, a stale token — is `info` or `warn`, never `error`. `error` means something is broken.

### Signals written to the log today

| Signal | Level | Why it matters |
|---|---|---|
| Per-tenant quota refusal | `warn` | A badly set limit must show in logs before it shows as a customer phone call |
| Redis unavailable / command failed | `error`, **once per outage** | Repeating it per request drowns the log during the incident someone is reading it for |
| Stale access version | `info` | The mechanism the permission cache depends on; observable before anything relies on it |
| Outbox events stuck after 10 attempts | `warn` | An event that will never be delivered is otherwise silent |
| Auth service unreachable / unexpected status | `error` | Every authenticated request is answering `503` |

## 2. Health and Readiness

| Endpoint | Decides | Behaviour |
|---|---|---|
| `GET /api/health` | Whether the process is **killed** | 200 while the process runs, regardless of dependencies |
| `GET /api/ready` | Whether traffic is **sent** | Reads a catalogue table as `hrms_app`, proving the connection *and* the role's rights; `503` + `retry-after` when not ready |
| `GET /health`, `GET /ready` | Same, on the auth service | Readiness reads as `hrms_auth` |

Readiness also **reports two facts** that cannot make an instance unready but are invisible otherwise:

```json
{ "status": "ready", "checkMs": 222, "rateLimit": "redis", "signing": "asymmetric" }
```

- `rateLimit: "in-process"` on a deployment with more than one replica means every limit is silently multiplied by the replica count.
- `signing: "unconfigured"` means this instance holds no private key and cannot issue tokens — every login through it fails. HS256 no longer exists (ADR-038).

Readiness replies carry no version, database name, or raw error — the endpoint is unauthenticated because an orchestrator calls it before any session exists.

## 3. Metrics

`GET /api/metrics`, Prometheus text format, **404 unless `METRICS_TOKEN` is set** (and 404 for a wrong token).

| Metric | Type | Labels |
|---|---|---|
| `hrms_http_requests_total` | counter | `route`, `status` |
| `hrms_http_request_duration_seconds` | histogram | `route` — buckets 10 ms … 10 s, clustered at the 500 ms target |

Counted once, at the single point every tenant-plane request passes through (`define-route.ts`).

**Never labelled by tenant, employee, or email.** A scrape endpoint is stored in a time-series database that outlives every access control in this system; a `tenant_id` label publishes the customer list. Per-tenant business figures — the flagged ratio, payroll disputes — belong on the dashboard behind a permission, where they already are. `metrics.test.ts` asserts the emitted output contains no UUID-shaped string at all.

Per-process counters are correct here: Prometheus scrapes each instance and sums them. (Sharing them would make each replica report the others' traffic.)

## 4. Audit Trails

Audit logs are for accountability, not for operating the system — but they are where an investigation starts.

| Trail | Holds | Integrity |
|---|---|---|
| `audit.audit_logs` | Every sensitive tenant-plane change, with actor, before/after, IP | Append-only: `UPDATE`/`DELETE` revoked and blocked by trigger |
| `platform.platform_audit_logs` | Superuser tenant status and plan changes — not logins | Separate from the tenant audit, so a tenant never sees actors it cannot recognise |
| `attendance.photo_access_logs` | HR opening a photo or document | The owner opening their own evidence is not logged; HR is |

Note the IP recorded in audit rows comes from the same client-controlled header as §9 of `15-API-CONTRACT.md` describes.

## 5. Scheduled Integrity Checks

| Check | Runs | Finds |
|---|---|---|
| `public.schema_drift_report()` | Daily, worker | A tenant table without RLS; RLS without a policy; a manual change outside migrations (R37) |
| INVALID index report | Every online migration run | A failed `CREATE INDEX CONCURRENTLY` — never used for reads, still maintained on writes |
| Stuck outbox count | Every pump cycle | Events past their retry limit |

## 6. Not Built

| Missing | Consequence |
|---|---|
| **Alerting of any kind** | Every signal above is written somewhere; nothing pages anyone |
| Error tracking (Sentry, named in `12` §6 Phase 1) | Uncaught errors are log lines, not grouped issues |
| Distributed tracing (OpenTelemetry) | Per-layer durations across backend → auth → database cannot be reconstructed |
| An uptime check | The availability target in `12` §11 is unmeasurable |
| Log shipping | Logs live in container stdout; `14` §9.3 records the vendor decision as open, and why sending PII-adjacent logs abroad is a legal question |
| Dashboards | There is nothing to look at between incidents |

These are tracked in `TASKS/` under Phase 6 hardening. The honest current state: **the system can explain a problem after someone notices it, and cannot notice one on its own.**
