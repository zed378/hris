# HRMS Documentation

Reference documentation for a multi-tenant HR management suite for Indonesian SMEs: employees, attendance (with geolocation and photo evidence), leave, and a payroll framework, delivered as a PWA. 45 documents across three categories.

The **execution plan** built from these documents lives in [`../TASKS/`](../TASKS/), and the record of what was actually built lives in [`../MEMORY/`](../MEMORY/). Agent instructions live in [`../CLAUDE.md`](../CLAUDE.md) and [`../AGENTS.md`](../AGENTS.md).

`docs/` is reference material. It is amended **deliberately**, through the deviation protocol in [`../TASKS/00-TASK-CONVENTIONS.md`](../TASKS/00-TASK-CONVENTIONS.md) — never edited as a side effect of implementation.

---

## How This Set Differs From a Pre-Build Plan

The structure follows [`zed378/zed-auth`](https://github.com/zed378/zed-auth), where every document was written before any code existed. This repository is the other way round, and it matters for how the documents should be read:

| Documents | Written | Nature |
|---|---|---|
| `PLAN/00`–`PLAN/12` | 2026-08, before and during the build | **Intent.** The plan as decided. Some of it describes a 16-service architecture that `PLAN/12` replaced with a modular monolith; `PLAN/12` wins wherever they disagree |
| `PLAN/13`, `PLAN/14` | During the build | **Status and the next architecture.** `PLAN/13` records what was proven and how; `PLAN/14` records the auth service split |
| `PLAN/15`–`PLAN/23`, `UI-UX/`, `SECURITY/` | 2026-09-13, against a running system | **Descriptive where the system exists, prescriptive where it sets a rule, and explicit about gaps.** Every "current state" claim was checked against the code on that date |

So when one of the later documents and the code disagree, **that is a finding, not a correction to make silently** — raise it in [`../TASKS/BACKLOG.md`](../TASKS/BACKLOG.md). Several were found while writing these documents, and they are recorded there rather than smoothed over here.

## Recommended Reading Order

```
1.  PLAN/00-Reference-System-Analysis.md       → the product, and principles P1–P16 (§3.2)
2.  PLAN/12-Small-Team-Execution-Plan.md        → the architecture actually built, and the phases
3.  PLAN/13-Implementation-Status.md            → what is proven, what diverged, what is open
4.  PLAN/02-Database-Modelling.md               → the data model (read with PLAN/12 §3 for the schema-per-module reality)
5.  PLAN/05-Dynamic-Role-Menu-Access.md         → permissions, menus, effective access
6.  PLAN/06-Multitenancy-Auth.md                → tenant isolation and authentication
7.  PLAN/15-API-CONTRACT.md                     → how every endpoint behaves
8.  SECURITY/00 → SECURITY/05                   → before touching auth, tenancy, PII, or attendance evidence
9.  UI-UX/00-DESIGN-DIRECTION.md                → before any screen work
10. PLAN/14-Service-Split-and-Platform-Evolution.md → before touching auth, caching, Redis, or the broker
```

`SECURITY/02-ATTACK-SURFACE-AND-SCENARIOS.md` is mandatory reading for anything touching authentication, authorization, tenant isolation, personal data, or attendance evidence. Task cards in `../TASKS/` name the scenarios they must be tested against, and they come from there.

## Folder Structure

```
PLAN/      24 files — 00–14 the original plan, status and service split;
                      15–23 API contract, testing, security baseline, performance,
                      observability, deployment & DR, acceptance criteria, risk
                      register, feature specification template
UI-UX/     15 files — design direction, personas, journeys, information
                      architecture, flows, design system, components, page
                      inventory, interaction, responsive & mobile, accessibility,
                      states, forms, language & copy, UX acceptance criteria
SECURITY/   6 files — assets and trust boundaries, threat actors, attack surface
                      and scenarios, detection, incident response, verification
```

### Why `PLAN/` keeps its numbering

`zed-auth` numbers its plan by topic: `05-API-CONTRACT`, `11-TESTING`, and so on. This repository's `PLAN/00`–`PLAN/14` already existed under different numbers, and **hundreds of code comments cite them as `docs/PLAN/NN §x`**. Renumbering to match would silently repoint every one of those references at the wrong document. So the existing numbers stay, and the topics `zed-auth` has that this plan lacked continue from `15`.

The mapping, for anyone arriving from `zed-auth`:

| `zed-auth` topic | Here |
|---|---|
| Project context, product scope, requirements | `PLAN/00` |
| Architecture, backend architecture | `PLAN/01` (blueprint) + `PLAN/12` §3 (as built) + `PLAN/14` (split) |
| Data model | `PLAN/02` |
| API contract | `PLAN/15` |
| Frontend architecture | `PLAN/11` |
| Authorization | `PLAN/05` + `PLAN/06` |
| Security baseline | `PLAN/17` |
| Threat model | `SECURITY/` + `PLAN/22` |
| Testing | `PLAN/16` |
| Performance | `PLAN/18` |
| Observability | `PLAN/19` |
| Deployment, disaster recovery | `PLAN/20` + [`../ops/RUNBOOK.md`](../ops/RUNBOOK.md) |
| Implementation roadmap | `PLAN/12` §5–6 |
| Acceptance criteria | `PLAN/21` |
| Risk register | `PLAN/22` |
| Feature specification template | `PLAN/23` |
| Public site architecture | Not applicable — there is no public site |

## Core Principles Binding All Documents

Sixteen principles are defined in [`PLAN/00`](./PLAN/00-Reference-System-Analysis.md) §3.2. These are the ones enforced in code, where an agent is most likely to break them without noticing:

| # | Principle | Enforced by |
|---|---|---|
| P6 | Tenants are isolated by default | RLS with `FORCE` on every `tenant_id` table, `NOBYPASSRLS` roles, `withTenant()`; `packages/db/test/tenant-isolation.test.ts`, `rls-coverage.test.ts` |
| P7 | No route without an explicit authorization decision | `ROUTE_MANIFEST`; `defineRoute` refuses an unregistered route; `apps/web/test/route-manifest.test.ts` |
| P8 | A subscription beats a role | `decideAccess`: `402` before `403`; `apps/web/test/gateway.test.ts` |
| P9 | The frontend hides, the backend refuses | Every screen control has a gateway counterpart; the gateway is right when they disagree |
| P11 | A superuser never bypasses RLS | A separate token audience and database role with no grant on tenant data |
| P12 | Migrations are always additive | `ops/scripts/lint-migrations.mjs`; online migrations in `packages/db/prisma/migrations-online/` |
| P13 | History is never overwritten | Period-based salary structures, versioned `statutory_configs` |
| P14 | Attendance evidence is scored, not trusted | Trust score + HR review queue; never auto-reject on one signal |
| P15 | Purpose limitation on location data | Location captured only at the moment of a punch; the live dashboard carries no coordinates |
| P16 | Offline for reading your own data, not for everything | The service worker never caches API, admin, or credential paths |

Two more rules are not numbered in `PLAN/00` but bind as firmly, because the build kept proving them:

- **`null` is not zero.** A figure a user may not see, or a module a tenant does not subscribe to, is `null` — never `0`. A zero reads as a fact.
- **A guard that cannot fail is not a guard.** Every new CI check is shown to fail against a deliberate violation before it is trusted. Two guards turned out to see less than they appeared to: the frontend boundary test matched nothing when first written (`PLAN/14` §10.8), and the route manifest check was blind to handlers written as `export function GET()` (`PLAN/13` §4, bug 18).

## Language

Documentation, code, comments, and **everything the backend produces** — API responses, error messages, logs — are in **English**. The **frontend is fully Indonesian**, because its users are Indonesian HR staff and employees, and it never shows a backend message directly (decided 2026-09-14, `MEMORY/DECISIONS.md` ADR-030). Emails and push notifications are still open — [`../TASKS/BACKLOG.md`](../TASKS/BACKLOG.md) `OQ-15`.

## How to Use This With an AI Agent

[`../CLAUDE.md`](../CLAUDE.md) carries the documentation map: which document to open for any task. Read it first — it is shorter than the plan and routes you correctly.

Then work through `../TASKS/`: one branch per task card, a feature specification in `../MEMORY/specs/` for anything touching authentication, authorization, tenant isolation, personal data, payroll, or the data model, and a record in `../MEMORY/records/` before the card is marked done.

**If a question is not answered in these documents, that is a real gap.** Raise it in `../TASKS/BACKLOG.md` rather than deciding it silently.
