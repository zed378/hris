# HRMS — HR Management Suite

Multi-tenant HRIS for Indonesian SMEs. A modular monolith built to be split into
services if — and only if — a measurable trigger appears.

The full blueprint lives in [`PLAN/`](PLAN/). The one that decides day-to-day
work: **[`PLAN/12-Small-Team-Execution-Plan.md`](PLAN/12-Small-Team-Execution-Plan.md)**
— phases, gates, and the reasoning behind every architectural decision.

Current state is tracked honestly, bugs included, in
**[`PLAN/13-Implementation-Status.md`](PLAN/13-Implementation-Status.md)**.

The agreed next architectural step — extracting **auth** into its own service,
and the message broker, Redis, and log shipping that follow it — is in
**[`PLAN/14-Service-Split-and-Platform-Evolution.md`](PLAN/14-Service-Split-and-Platform-Evolution.md)**.
Decided, not yet built; the containers below are still the ones that exist.

> The product interface is in Indonesian, because its users are Indonesian HR
> staff. Code, comments, and documentation are in English. Do not translate
> user-facing strings, error messages, seed data, or leave-type names.

---

## Running locally

Prerequisites: Node 24+, pnpm 11+, Docker.

```bash
cp .env.example .env          # dev credentials are pre-filled
pnpm install
pnpm db:up                    # PostgreSQL 18 on port 5433
pnpm db:migrate
pnpm db:seed

pnpm --filter @hrms/web dev       # API on :3000
pnpm --filter @hrms/worker dev    # outbox pump
```

**Demo tenant** — `tenantCode: demo`, `owner@demo.test`, `DemoPassword123`.
Its plan is `starter` (**no** payroll) so that entitlement enforcement is
visible from day one: the Payroll menu is not rendered and its endpoints reject
with 402, even though TENANT_OWNER holds every permission.

```bash
curl -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"tenantCode":"demo","email":"owner@demo.test","password":"DemoPassword123"}'
```

**Demo superuser** — `admin@hrms.test`, `AdminPassword123`, TOTP required.
`pnpm db:seed` prints the TOTP secret; turn it into a live code with:

```bash
pnpm dev:totp <base32-secret>
```

## Running as containers

For day-to-day development the commands above are better — hot reload beats
rebuilding images. The full stack is for reproducing problems that only appear
in an image, and for deployment.

```bash
cp ops/.env.compose.example ops/.env      # replace both JWT secrets before production
docker compose -f ops/docker-compose.yml --env-file ops/.env up --build
```

Three containers, and no more:

| Container | Role | Exposed |
|---|---|---|
| `postgres` | Data, job queue (pg-boss), distributed locks (advisory locks) | port 5433 (dev) |
| `web` | **Frontend** — UI and the whole REST API (`/api`, `/admin/api`) | port 3000 |
| `worker` | **Backend** — outbox pump, payroll runs, scheduled jobs | nothing |

PostgreSQL doing three jobs at once is what makes this stack operable by one
person: there is no RabbitMQ and no Redis to keep alive (PLAN/12 §3.2). Both are
now planned rather than ruled out — `PLAN/14` §9 sets out what has to become true
first, and why the rate limiter is already wrong the moment `web` runs on more
than one replica.

The `migrate` service runs to completion before `web` and `worker` start, and it
is the only one using owner credentials.

## Verification

```bash
pnpm verify        # migration linter + module boundary lint + typecheck + test + build
```

> Do not use `pnpm ci` — that is pnpm's own command (clean install), not this
> script.

---

## Layout

```
apps/web            Next.js — UI and API route handlers for the tenant plane
                    (/api) and the control plane (/admin/api)
apps/worker         Background process — outbox pump, pg-boss, scheduled jobs
packages/core       Domain modules: tenant, iam, auth, employee, attendance,
                    leave, payroll, notification, reporting, platform
packages/db         Prisma, migrations, tenant context, audit, outbox
packages/contracts  Zod schemas: API, tokens, events, shared catalogues
packages/observability  Structured logging and request context
ops/                docker-compose, web & worker Dockerfiles, migration linter,
                    backup/restore and point-in-time recovery scripts
```

### Four rules that make this more than a monolith

All four are machine-enforced, not agreements. Together they are what makes
splitting one module into a service take 4–6 weeks rather than 4–6 months
(PLAN/12 §9).

1. **Modules only talk through `index.ts`.** Enforced by
   `eslint-plugin-boundaries`. Importing into another module's internals fails
   the build.
2. **Events go through the outbox table**, not cross-domain function calls. The
   code has the same shape it would have in a distributed version.
3. **One PostgreSQL schema per module.** Moving a module means moving a schema,
   not dismantling tables.
4. **Every route is registered in `ROUTE_MANIFEST`** with its module and
   permission. An unregistered route cannot run.

---

## What to know before writing code

### Every tenant data access goes through `withTenant()`

```ts
import { withTenant } from '@hrms/db';

await withTenant(tenantId, async (tx) => {
  return tx.user.findMany();   // RLS fully in force
});
```

Without context, queries return **zero rows** — not the whole table. Deliberately
fail-closed: a cross-tenant leak does not throw, it just shows someone else's
data.

The application runs as the `hrms_app` role (`NOBYPASSRLS`, not the table
owner). The owner role is only used by the Prisma CLI during migrations.

### Do not write side effects in a transaction that ends in `throw`

A `throw` inside `withTenant()` rolls its transaction back. Side effects that
must survive a rejected request — failed-attempt counters, account locks, token
revocation — belong in a separate transaction **after** the first one commits.

The pattern is in [`packages/core/src/auth/login.ts`](packages/core/src/auth/login.ts):
the transaction returns an outcome, the caller throws.

This is not a matter of style. The first version broke it, and the result was
that ten wrong passwords left `failed_login_attempts = 0`. Account locking
existed in the code, passed review, and did nothing.

### Tokens never touch persistent storage

The access token lives **only in JavaScript memory**. The refresh token lives
**only as an httpOnly cookie** — it is not returned in the login body, so page
scripts never hold it (PLAN/11 §5.3).

The consequence: reloading the page discards the access token, and the app
exchanges the cookie for a fresh one on load. What XSS can steal is a token that
expires in 15 minutes.

Non-browser clients (scripts, tests) must use a cookie jar too — `curl -c/-b`.

> `COOKIE_SECURE` is deliberately not derived from `NODE_ENV`. `next start` sets
> NODE_ENV to production, so testing a production build over HTTP on your own
> machine would always break sessions — browsers drop `Secure` cookies on plain
> connections for every hostname except localhost, with no server-side error at
> all. The default stays safe; turn it off only for local testing.

### The menu comes from the database, not from frontend code

The sidebar is rendered entirely from `/api/me/bootstrap`. Enabling a module in
the control plane changes tenant navigation immediately, without a deploy.

`apps/web/test/menu-coverage.test.ts` checks that every menu path has a page and
that every permission code it names exists. Four menu entries once pointed at
404s for months, because the menu is assembled from data and TypeScript cannot
see the connection to a `page.tsx`.

### Tell a revoked session apart from a stolen token

A refresh token that was **already rotated** and then shows up again means two
parties hold the same token — that is a theft signal, recorded as an incident,
and the whole token family is revoked.

A **revoked** refresh token only means the session ended legitimately: logout,
password reset, or cleanup after an incident. Both produce a 401 and force a new
login, but only the first should raise an alarm.

The first version conflated them, so everyone who forgot their password
triggered `auth.token.reuse_detected`. An alarm that is usually wrong is an
alarm that gets ignored when it is right.

### Migrations are additive only

No `DROP`, `RENAME`, or `TRUNCATE`. Enforced by
`ops/scripts/lint-migrations.mjs`. The full rules and the deprecation ladder are
in [`PLAN/09`](PLAN/09-Non-Destructive-Migration-Strategy.md).

RLS is written by hand in migrations — Prisma does not generate it. Every table
with a `tenant_id` **must** have a policy; a CI test reads the PostgreSQL
catalogue and fails if one is missing.

### Four database principals, each as narrow as possible

| Role | Used by | Cannot reach |
|---|---|---|
| `hrms_owner` | Prisma CLI during migrations | — |
| `hrms_app` | Web runtime, tenant plane | `platform` schema |
| `hrms_worker` | Background process | `platform` schema; RLS fully in force except on the outbox |
| `hrms_platform` | Control plane | `auth.users`, `iam.*`, `audit.*` |

That last row is what carries P11. If someone later writes a read of
`auth.users` into control-plane code, PostgreSQL refuses it — not a reviewer who
happened to be paying attention. Grants into the `tenant` schema are given **per
table**, not by sweep, so the next domain module will never be exposed to the
control plane without someone deciding it.

The control plane can suspend a tenant, and that grant is narrow in the same
way: `UPDATE` on **four columns**, not on the table.

### Four RLS exceptions, and only four

All of them are listed, commented in their migration, and counted by a CI test:

| Exception | Reason |
|---|---|
| `resolve_tenant_by_code` | The login path needs a tenantId before context can be set |
| `resolve_refresh_token_owner` | The same problem on the refresh path |
| `platform.tenant_user_counts` | The global dashboard needs a count; SELECT on `auth.users` would hand over its contents |
| `outbox_publisher` policy | The event pump is infrastructure; `hrms_worker` only, one table only |

`rls-coverage.test.ts` fails when a fifth exception appears — forcing whoever
adds it to justify it in the PR rather than slipping it in.

### Two planes, two guards, never mixed

`defineRoute` for `/api/**`, `defineAdminRoute` for `/admin/api/**`. Two separate
functions on purpose, not one with an `isAdmin` parameter: the moment such a
parameter exists, a single boolean mistake is all that separates every
customer's metadata from someone who should not have it.

A CI test checks both directions — an admin handler using the tenant guard (or
the reverse) fails the build.

> Next.js note: the admin route folder **must not** start with an underscore.
> `_admin` is a private folder excluded from routing, and the only symptom is a
> route quietly missing from the build output.

---

## What works

Tracked in detail, with every bug found and how it was proven, in
[`PLAN/13`](PLAN/13-Implementation-Status.md). In outline:

- **Platform** — multi-tenancy with fail-closed RLS, self-service registration,
  roles and permissions, per-user grant/deny, audit trail, transactional outbox,
  control plane with tenant suspension and module toggles
- **Employees** — records with encrypted PII (AES-256-GCM, blind index, stored
  masked columns), documents, contracts with expiry reminders, Excel import and
  export
- **Attendance** — punches with geofence and photo evidence, trust scoring,
  review queue, shifts and schedules, holidays and joint leave, device import,
  manual correction, tenant-configurable policy
- **Leave** — balances with a hold/consume/release ledger, accrual methods,
  carry-over, file attachments, approval with separation of duties
- **Payroll** — components and formulas, salary structures, runs calculated in
  the worker as committed batches, payslips
- **Cross-cutting** — `.xlsx` export in every module, monthly attendance recap,
  Web Push, structured logging with correlation IDs, backups and point-in-time
  recovery

## What does not

- **PPh21 and BPJS are not calculated.** Payroll computes only the components a
  tenant configures. This is Gate C: it needs a payroll expert and 30 real
  payslips as regression cases before it can be trusted. The payroll screen says
  so in a banner.
- **Billing** — subscription model, entitlement, trials, and suspension all
  work; the payment gateway integration needs Midtrans/Xendit sandbox
  credentials.
- **WhatsApp notifications** — the third tier for urgent messages, needs a
  WhatsApp Business API account.
- **Support sessions** (PLAN/07 §6). Until they exist, the answer to "how does
  support look at customer data?" is **they cannot** — not a temporary back door.

Order and gates are in [`PLAN/12`](PLAN/12-Small-Team-Execution-Plan.md) §6.
