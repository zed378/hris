# 16 — Testing Strategy

What a test in this repository must prove, which layer it belongs to, and what "passing" is allowed to mean. Written 2026-09-13 from the 36 test files that exist, not from an intended pyramid.

The single lesson the build kept teaching is recorded in `13-Implementation-Status.md` §4: **every serious defect failed silently.** A cross-tenant leak throws no error. A punch filed on the wrong date throws no error. A guard that matches nothing throws no error. So the question every test must answer is not "does it pass?" but **"could it have failed?"**

---

## 1. The Rules

1. **No mocked data layers.** Tests that involve data talk to a real PostgreSQL, a real Redis, or a real NATS. A fake proves only that the fake agrees with the assertion — it cannot show that `effectiveTo: null` selects the open period, that RLS hides a row, or that a Lua script is atomic. There are no `vi.mock` calls and no hand-built `TenantClient` fakes anywhere in the suite, and there must not be.
2. **Setup as owner, assert as the application.** Fixtures are created with an owner-privileged Prisma client, because `tenant.tenants` is itself RLS-protected. Assertions go through `withTenant()` — otherwise the test proves PostgreSQL can read rows rather than that the application can. The eslint exemption allowing `@prisma/client` in tests is scoped to `**/test/**` for exactly this reason.
3. **Every tenant is created fresh, with a random UUID, and deleted afterwards.** Suites share one database and run serially (`fileParallelism: false`); they must never share rows.
4. **A guard is not trusted until it has been seen to fail.** Every structural check — a lint rule, a coverage test, a boundary test — is run once against a deliberate violation before it is committed. The frontend boundary test passed while matching nothing — its regex escapes were lost when written to disk — and was caught only by a deliberate violation (`14` §10.8). The route manifest check recognised only `export const GET =`, so a handler written as `export function GET()` escaped registration and permission checks entirely (`13` §4, bug 18). A single-column foreign key on `employee_documents` looked right until a deliberate cross-tenant insert succeeded (commit `61f2291`). See `MEMORY/DECISIONS.md` ADR-020.
5. **An optional dependency that is absent skips, and says so. One that is configured but unreachable fails.** Skipping in both cases would let a broken Redis in CI look exactly like a developer who never started one.
6. **Security-sensitive work ships with an abuse-case test**, drawn from `docs/SECURITY/02-ATTACK-SURFACE-AND-SCENARIOS.md`. A feature whose happy path works and whose abuse case is untested is not done.
7. **Assert on the stable part of an error, not its prose.** Match the error code or the variable name an operator must set — never a sentence, which is rewritten and translated. One test broke for exactly this reason (`MEMORY/records/2026-09-13-concurrent-agent-commits.md`).

## 2. The Layers

```
        ┌──────────────────────────────┐
        │ End to end on a running app  │  manual today; recorded in PLAN/13 §3
        ├──────────────────────────────┤
        │ Structural guards            │  manifest, menus, boundaries, migrations
        ├──────────────────────────────┤
        │ Integration: real services   │  PostgreSQL, Redis, NATS, HTTP
        ├──────────────────────────────┤
        │ Unit: pure functions         │  parsers, scoring, dates, crypto
        └──────────────────────────────┘
```

### Unit — pure functions

Formula parsing (`formula.test.ts`, 33 cases — including `eval`, `require`, `__proto__` refused), device CSV formats, import schema, working-date boundaries in WIB/WIT, trust scoring, leave day counting and accrual, photo handling, PII encryption and key rotation, CIDR and client-address normalisation, JWT signing (including `alg: none` and HS256-with-public-key forgery), metrics exposition, log redaction, the offline queue, and the service worker run inside a VM.

### Integration — real services

| Suite | Talks to | Proves |
|---|---|---|
| `packages/db/test/tenant-isolation.test.ts` | PostgreSQL | Tenant context cannot leak; `set_config` is bound, not concatenated; audit rows cannot be updated or deleted |
| `packages/db/test/rls-coverage.test.ts` | PostgreSQL | Every `tenant_id` table has RLS; no role bypasses it; the `hrms_auth` and `hrms_platform` grant matrices |
| `packages/core/test/authorize.test.ts` | PostgreSQL + Redis | The authorization decision and its check order |
| `packages/core/test/leave-approver.test.ts` | PostgreSQL | Manager resolution across six incomplete chains; permission holders |
| `packages/core/test/trends.test.ts` | PostgreSQL | Month bucketing, gaps reported as gaps, `null` not zero |
| `packages/cache/test/*.test.ts` | Redis | Shared rate limits across a simulated second replica; cold-start; both cache invalidation axes |
| `apps/web/test/gateway.test.ts` | PostgreSQL + Redis | P7, P8, P9, `TENANT_MISMATCH`, DENY precedence, access version — the real handler with a real `Request` |
| `apps/auth/test/service.test.ts` | PostgreSQL + Redis + HTTP | The auth service over a real socket: routing, internal-secret guard, cookies, the authorize RPC |
| `apps/worker/test/broker.test.ts` | NATS | Delivery, envelope integrity, topic isolation, no redelivery, ordering |

### Structural guards

| Guard | Refuses |
|---|---|
| `apps/web/test/route-manifest.test.ts` | A `route.ts` without a manifest entry, or the reverse; an unlimited guessable public route |
| `apps/web/test/menu-coverage.test.ts` | A menu entry pointing at a page that does not exist |
| `apps/web/test/api-call-coverage.test.ts` | A client call to an endpoint that does not exist |
| `apps/web/test/frontend-boundary.test.ts` | A page importing a server-only package, a route handler, or the manifest |
| `packages/db/test/online-migrations.test.ts` | A non-re-runnable online migration; one that did not need to be online |
| `ops/scripts/lint-migrations.mjs` | `DROP`, `RENAME`, `TRUNCATE`, non-concurrent indexes on live tables, `CONCURRENTLY` inside a Prisma migration |
| `eslint-plugin-boundaries` | A cross-module import other than through the module's `index.ts` |

### End to end — on a running application

Every row of `13-Implementation-Status.md` §3 was proven against a running server — with `curl`, a second account, and a database query afterwards — not by a unit test. That is how the tenant timezone bug, the approver-list bug, the cache cold-start bypass, and the auth service's 503-for-a-bad-token were found.

**It is not automated.** There is no Playwright suite, and no end-to-end run in CI. Those proofs held on the day they were run.

## 3. Running the Suite

```bash
pnpm db:up                                  # PostgreSQL, Redis
pnpm db:migrate && pnpm db:seed
pnpm verify                                 # lint:migrations → lint → typecheck, test, build
pnpm --filter @hrms/core test               # one package
```

NATS is not part of `db:up`. The broker suite skips without it:

```bash
docker run -d --name hrms-nats -p 4222:4222 nats:alpine -js
```

## 4. What Is Not Tested

Stated so that a green `pnpm verify` is not read as more than it is.

| Not covered | Consequence | Where tracked |
|---|---|---|
| Browser end-to-end (Chromium, WebKit) | UI regressions are found by hand | `TASKS/` |
| Lighthouse PWA and performance scores (`12` Phase 3 DoD) | Not verified | Blocked on devices |
| Real Android and iPhone devices (`12` spike S4) | Permissions, indoor GPS, iOS queue eviction unverified | Blocked on devices |
| Load and latency | The p95 target in `12` §11 is unmeasured | `18-PERFORMANCE-AND-CAPACITY.md` |
| Proxy routing rules (`ops/proxy`) | Only `nginx -t` syntax is checked | `TASKS/` |
| Container image builds | `Dockerfile.auth` built once by hand | `TASKS/` |
| OpenAPI route coverage | 14 of 100 routes documented; no test | `TASKS/BACKLOG.md` |
| Payroll golden regression (30 real payslips) | Cannot exist before Gate C | Gate C |
| `X-Forwarded-For` spoofing | Undetected by any test, which is how it survived | `SECURITY/02` §4 |

## 5. Definition of a Good Test Here

- It names, in its comment, the failure it exists to catch — usually one that would be silent.
- It constructs the state where the bug would show, including **two things wrong at once** when the code has an order of checks.
- It asserts both sides of a boundary: 11 characters refused *and* 12 accepted.
- It cleans up what it created, and nothing else.
- It has been seen to fail.
