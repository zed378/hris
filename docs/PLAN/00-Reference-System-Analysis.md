# 00 — Reference System Analysis & Product Scope

**Reference source:** https://casadigital.id/hrscientist-hrmanagement/
**Reference product name:** HRIS Scientist — HR Management (Excel-based)
**Analysis date:** 17 August 2026

---

## 1. Summary of the Reference System

The reference product is an **Excel-workbook HRIS** sold as a one-time digital
purchase through a third-party checkout platform (lynk.id). Its selling point is
not technical sophistication but:

1. **Zero learning curve** — users stay in Excel and learn no new software.
2. **Data consolidation** — replaces many scattered files with one workbook and
   one dashboard.
3. **Low price** — Rp 99,000 – Rp 199,000 (50–80% off the struck-through price).
4. **End-to-end coverage** — HR administration from attendance through appraisal.

### 1.1 Feature Inventory (extracted from the page)

| # | Feature | Description on the reference | Package |
|---|---------|------------------------------|---------|
| 1 | Daily Presence | Track daily employee attendance | Basic |
| 2 | Leave Calendar | Manage leave schedules, permits, remaining entitlement | Basic |
| 3 | Employee Performance | Structured performance appraisal | Basic |
| 4 | Wages & Salary | Payroll management | Basic |
| 5 | RACI Matrix | Role responsibility matrix | Advanced |
| 6 | DACI Matrix | Decision-making matrix | Advanced |
| 7 | Internal Relation | Employee database + employee issues | Advanced |
| 8 | FTE Table | Workload / Full-Time Equivalent analysis | Ultimate |
| 9 | Employee Recruitment | End-to-end recruitment | Ultimate |
| 10 | Employee Development Plan | Employee development planning | Ultimate |

### 1.2 Commercial Structure (Tiering)

| Package | List price | Sale price | Modules |
|---------|-----------|------------|---------|
| Basic | Rp 199,000 | Rp 99,000 | 4 |
| Advanced | Rp 596,000 | Rp 149,000 | 7 |
| Ultimate | Rp 745,000 | Rp 199,000 | 10 |

**The most important architectural finding:** the reference's commercial
structure is **already naturally modular**. Each feature is a sheet or set of
sheets that can be added or removed, and a package is a bundle of modules. This
is direct business justification for a **plug-and-play / add-on** architecture in
the web version — we are not imposing modularity, we are moving an existing
business model onto the software architecture that fits it.

---

## 2. Gap Analysis: Excel → Web Application

| Dimension | State in the reference (Excel) | Consequence | Solution in this blueprint |
|-----------|-------------------------------|-------------|----------------------------|
| **Concurrency** | One file, effectively one writer. Multi-user over a shared drive causes version conflicts (`file_final_v2_revised.xlsx`) | Data loss, manual race conditions | PostgreSQL + ACID transactions, optimistic locking, advisory locks (doc 03) |
| **Data integrity** | No foreign keys; a national ID can be mistyped, leave can go negative | Payroll miscalculation | FK constraints, `CHECK`, unique partial indexes, state machines (doc 02) |
| **Audit trail** | None. Who changed whose salary is untraceable | Fraud and labour-dispute risk | Append-only `audit_logs` table + triggers (doc 02) |
| **Real time** | Manual refresh, resend the file | Management dashboards are always stale | WebSocket fan-out via Redis Pub/Sub (doc 03) |
| **Heavy workloads** | Payroll for 1,000 employees freezes Excel | Does not scale | Message queue + asynchronous workers (doc 03) |
| **Security** | Excel sheet passwords are trivially broken; everyone sees every salary | Personal data breach (Law 27/2022, UU PDP) | RBAC/ABAC, Row-Level Security, encryption of sensitive columns |
| **Compliance** | PPh21/BPJS formulas hardcoded in cells; they change with every regulation | Incorrect tax withholding | Payroll component configuration tables + a versioned rule engine |
| **Integration** | No API; fingerprint machine data entered by hand | Human error in attendance | Attendance device connectors, REST/webhook API |
| **Scale** | Practically caps out around 200 employees | Cannot move upmarket | Table partitioning, indexing, horizontal scaling |

### 2.1 What Must Be **Kept** from the Reference

The common mistake when "upgrading" an Excel product is throwing away its
advantages. Three things must survive:

1. **Grid familiarity** — the main UI for bulk entry must be a
   **spreadsheet-like grid** (paste from Excel, keyboard navigation, bulk edit),
   not one form at a time.
2. **Excel import/export as a first-class citizen** — every module needs an
   `.xlsx` template for import and an export. This is also the migration path
   for existing customers of the reference product.
3. **Short time-to-value** — a user must see a dashboard with real data within
   30 minutes of registering (through an Excel import wizard).

---

## 3. Target Product Positioning

**Working name:** *HR Management Suite (HRMS)*
**Model:** Multi-tenant B2B SaaS, monthly/annual subscription, with an **add-on
catalogue** that can be enabled per tenant.
**Target segment:** Indonesian SME to mid-market, 20–2,000 employees (the segment
currently buying the reference Excel product, plus the segment above it that has
outgrown Excel).

### 3.1 Mapping Reference Modules → Services

Each reference feature becomes a standalone service with its own database.
Modules too small to stand alone are merged by conceptual affinity, not split
for tidiness.

```
PLATFORM SERVICES (always on, unrelated to subscription)
├── api-gateway          single entry point, X-Tenant-ID validation, entitlement, permission
├── auth-service         login (tenantCode + email + password), JWT, sessions
├── iam-service          roles, permissions, menus, per-user access
├── tenant-service       tenants, subscription plans, module activation
├── notification-service email, push, WhatsApp
├── file-service         upload/download, presigned URLs
├── realtime-service     WebSocket gateway
└── reporting-service    cross-domain read model (CQRS)

DOMAIN SERVICES — TIER 1 (equivalent to the Basic package)
├── employee-service     → Internal Relation (employee database) — core module, always on
├── attendance-service   → Daily Presence
├── leave-service        → Leave Calendar
├── performance-service  → Employee Performance
└── payroll-service      → Wages & Salary

DOMAIN SERVICES — TIER 2 (equivalent to the Advanced package)
├── planning-service     → RACI Matrix + DACI Matrix
└── relation-service     → Internal Relation (employee issues, warnings, grievances)

DOMAIN SERVICES — TIER 3 (equivalent to the Ultimate package)
├── recruitment-service  → Employee Recruitment (end-to-end ATS)
└── planning-service     → FTE Table + Employee Development Plan (additional modules on the same service)

EXTENSIONS (outside the reference scope, new monetisation opportunities)
├── ESS Mobile           Employee Self Service
├── device-bridge        Fingerprint / face recognition device integration
├── e-signature          Digital contract signing
└── analytics-plus       Turnover prediction, cost-to-hire

PROPOSED EXPANSION MODULES (detail and priority in document 08)
├── contract-compliance  Fixed-term contract, certificate, and permit expiry reminders  [Basic, priority 1]
├── claim                Reimbursement, travel requests, employee advances/loans        [Advanced, priority 2 & 4]
├── onboarding           Cross-department onboarding & offboarding                      [Advanced, priority 3]
├── hse                  Health & safety: incidents, HIRADC, inspections, certification [Industry add-on, priority 5]
├── asset                Assets & inventory, handover, clearance                        [Advanced]
├── training             Training history & certificate validity                        [Ultimate]
├── helpdesk             Employee question ticketing                                    [Advanced]
├── engagement           Pulse surveys, eNPS                                             [Ultimate]
├── roster-planning      Advanced shift scheduling                                       [Industry add-on]
└── multi-entity         Company groups with several legal entities                      [Industry add-on]
```

**A distribution signal worth recording:** the Basic package checkout link on the
reference page points at `lynk.id/komunitashse`, while the other packages point
at `lynk.id/hrscientist`. The seller has access to a community of health &
safety practitioners — an audience already assembled and already proven to buy.
That makes the `hse` module the candidate with the lowest customer acquisition
cost among all the proposals (full analysis in document `08`, §1.2).

**A note on the split:** RACI/DACI, the FTE Table, and the Development Plan sit
in one `planning-service` because all three share the same concepts (activities,
roles, targets) and none is large enough to stand alone. Splitting them into
three services would add operational cost with no benefit. Conversely,
`attendance-service` and `payroll-service` do stand alone because their load
profiles differ from the others by two orders of magnitude and both need to scale
independently.

**A module is not a service.** One service can provide several subscribable
modules (`planning-service` provides `raci-daci`, `workforce-planning`, and
`development`). Entitlement is evaluated per module at the gateway, not per
service.

### 3.2 Design Principles Binding the Whole Blueprint

| Principle | Technical implication |
|-----------|----------------------|
| **P1. Thin platform services, thick domain services** | Platform services (auth, iam, tenant) must know nothing about HR logic. Dependencies run one way only: domain → platform. |
| **P2. Services communicate by event, not direct call** | `payroll-service` does not call `attendance-service` to learn about changes; it subscribes to `attendance.period.closed`. Synchronous gRPC is reserved for the four paths that cannot be deferred. |
| **P3. A module can be disabled without breaking the system** | Every event consumer must tolerate an event that never arrives (graceful degradation). |
| **P4. Every heavy operation is asynchronous** | Payroll runs, Excel imports, payslip PDF generation, attendance recaps → queue, not HTTP request-response. |
| **P5. Every financial or personal data change is audited** | No silent `UPDATE` on payroll or employee tables without a trace. |
| **P6. Tenants are isolated by default** | Row-Level Security is active at the database level of every service, not only in the application. |
| **P7. No gateway route without an explicit authorisation decision** | Every route must be registered in `ROUTE_MANIFEST` with its module and permission; an unregistered route returns 404. |
| **P8. Subscription beats role** | Permissions from a module the tenant does not subscribe to lapse automatically during resolution, without revoking any role. |
| **P9. The frontend hides, the backend refuses** | An unrendered menu is a convenience only; every UI control has a counterpart at the gateway. When they disagree, the gateway is right. |
| **P10. No service touches another service's database** | Enforced by PostgreSQL grants, not by agreement. Violating it turns microservices into a distributed monolith. |
| **P11. A superuser never bypasses RLS** | The control plane is separate from the tenant plane. Superuser access to tenant data goes only through a tenant-approved support session, through the same gateway as an ordinary user. There is no back door. |
| **P12. Migrations are always additive** | `ADD`, never `DROP` or `RENAME`. The schema must stay compatible with the previous application version, so an application rollback is always safe. Column removal happens only through a staged deprecation ladder with archival. |
| **P13. History is never overwritten** | Time-dimensioned data (tax rates, salary structures, leave policies) has its period closed and a new row appended — never `UPDATE`d in place. Last year's payslip must not change because of this year's regulation. |
| **P14. Attendance evidence is scored, not trusted** | Coordinates and photos are device claims and can be faked. The system assigns a trust score and flags anomalies for human review — it does not accept or reject automatically on a single signal. |
| **P15. Purpose limitation on location data** | Location is captured only at the moment of a punch, never in the background, and never forwarded to `reporting-service` as raw coordinates. This is what separates an attendance tool from a surveillance tool. |
| **P16. Offline for reading your own data, not for everything** | Caching is granted for a user's own personal data; salary data, aggregate dashboards, and confidential cases are never stored on the device. The only offline write is a punch, because that is the only thing genuinely blocked by a missing network. |

---

## 4. Non-Functional Requirements (Measurable Targets)

| Category | Target |
|----------|--------|
| Availability | 99.5% monthly (MVP) → 99.9% (GA) |
| API latency | p95 < 300 ms for reads, p95 < 800 ms for writes |
| Dashboard push latency | < 2 seconds from event to visible on screen |
| Payroll run | 1,000 employees < 3 minutes, 10,000 employees < 20 minutes |
| Excel import | 5,000 rows < 60 seconds with per-row error reporting |
| RPO / RTO | RPO 5 minutes (PITR), RTO 1 hour |
| Audit retention | 7 years (following labour and tax document obligations) |
| Compliance | Law 27/2022 (UU PDP), Labour Law, PPh21 TER scheme, BPJS employment & health |

---

## 5. Blueprint Document Index

| File | Contents |
|------|----------|
| `00-Reference-System-Analysis.md` | This document — reference analysis, gaps, scope |
| `01-Architecture-Tech-Stack.md` | Microservice architecture, service catalogue, inter-service communication, data consistency, gateway & subscription-based menu ingestion, tech stack |
| `02-Database-Modelling.md` | PostgreSQL schema per service, read replicas, RLS, DDL, indexing |
| `03-Queue-WebSocket-Implementation.md` | Event bus, outbox, sagas & compensation, WebSocket, distributed concurrency |
| `04-Development-Phases.md` | Roadmap, team, estimates, DoD, risk management |
| `05-Dynamic-Role-Menu-Access.md` | Roles, menus, permissions, per-user grant & deny, delegation, access review |
| `06-Multitenancy-Auth.md` | Multitenancy model, `X-Tenant-ID`, early-phase authentication, tenant lifecycle, noisy neighbours |
| `07-Global-And-Tenant-Dashboards.md` | Control plane / tenant plane separation, global dashboard (superuser), tenant & team dashboards, support sessions |
| `08-Expansion-Module-Catalogue.md` | Proposed additional modules, prioritisation framework, modules deliberately not built, package & pricing impact |
| `09-Non-Destructive-Migration-Strategy.md` | Additive migration rules, safe ALTER recipes, backfill, deprecation ladder, migration CI gate |
| `10-Attendance-Geolocation-Photo.md` | Camera & location permissions, geofencing, photo evidence, layered trust scoring, offline punches, privacy |
| `11-PWA-Frontend.md` | Service worker, per-tenant caching, offline queue, Web Push, platform limits, performance budget |
| `12-Small-Team-Execution-Plan.md` | **Execution plan for a team of 1–3.** A modular monolith ready to be split, scope of 4 core modules, commercial gates, re-estimation. Supersedes roadmap `04` §2–§10 |
| `13-Implementation-Status.md` | **The actual state**: what has been built and proven, deviations from the plan and why, bugs found through end-to-end testing, and what remains open. Document `12` states intent; this one states reality |

**Suggested reading order:** `00` → `01` → `06` → `07` → `05` → `02` → `09` →
`03` → `10` → `11` → `04` → `08` → `12`.

Document `12` is read alongside `04`: `04` lays out a roadmap for a 14–15 FTE
team on full microservices, `12` re-plans execution for the real team capacity
(1–3 people) with a modular monolith and reduced scope. Where they conflict on
order, phase, or estimate, **`12` wins**; `04` remains the reference if team
capacity ever reaches its assumptions.

Document `11` is read alongside `10`: the PWA extends attendance to every device
but weakens some of the evidence signals designed in `10` — the adjustments are
in `11` §2.2.

Document `09` is read alongside `02`: one defines the shape of the schema, the
other defines how that shape is allowed to change.

Documents `06` and `05` are cross-cutting: both bind every service and must be
settled before the first domain service is written. Document `05` was written for
a single-schema architecture; its §12 explains the adjustments needed to run it
as a standalone `iam-service`.
