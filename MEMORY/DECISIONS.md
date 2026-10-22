# Decision Log (ADRs)

Every architectural decision the plan left open, and every deviation from what the plan decided.

**When to write one**: a decision the plan does not contain; a deviation from the plan (mandatory, `TASKS/00-TASK-CONVENTIONS.md` §7); a choice that will be questioned later; a decision **not** to build something.

**When not to**: an implementation detail obvious from the code that nobody would question.

## Format

```
## ADR-NNN — <Title>

| | |
|---|---|
| **Date** | YYYY-MM-DD |
| **Status** | Proposed / Accepted / Superseded by ADR-NNN / Rejected |
| **Task** | <task id, or — > |
| **Deciders** | |
| **Reconstructed** | No / Yes — from <sources> |

**Context** — the situation forcing a choice.
**Decision** — what was chosen.
**Alternatives considered** — each option and why it was not chosen.
**Consequences** — easier, harder, foreclosed. Include the drawbacks.
**Plan impact** — none, or which document is amended and whether it has been.
```

Numbers are sequential and permanent. A superseded ADR stays, with its status updated and a pointer forward.

**ADR-001 to ADR-029 are reconstructed** (written 2026-09-13); ADR-030 onwards are contemporaneous. Their decisions are taken from the plan documents, `docs/PLAN/13` §2, `docs/PLAN/14` §10, commit messages, and code comments — each cites its source. Dates are the commit that put the decision into the code. Deciders are recorded as "not recorded" where no source names them; the repository has a single committer identity.

---

## ADR-001 — A modular monolith instead of sixteen services

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P0-02 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §1–3 |

**Context** — `docs/PLAN/01` and `04` designed 16–24 services on Kubernetes with RabbitMQ, gRPC, sagas, and two Platform/SRE engineers. The team is one or two people.

**Decision** — one web deployable and one worker, domain logic in framework-free `packages/core` split into modules, each module's public surface its `index.ts`, the boundaries enforced by lint (ADR-004) so the system can be split later (`docs/PLAN/12` §9).

**Alternatives considered** — the microservice blueprint (`01`): rejected because its operational load exceeds the team (risks R10–R14, R29); a monolith without enforced boundaries: rejected because boundaries dissolve silently (risk N1).

**Consequences** — one build, one deploy, one log; five categories of distributed failure removed. A bug can take down everything (N2). Splitting later depends on the boundaries staying real.

**Plan impact** — `docs/PLAN/12` supersedes `01` and `04` where they disagree. `01` and `04` carry no notice saying so (`PG-05`).

## ADR-002 — One PostgreSQL database, a schema per module

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P1-01 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §3.2 |

**Context** — `01` gave each service its own database.

**Decision** — PostgreSQL 18, one database, schemas `tenant`, `auth`, `iam`, `employee`, `attendance`, `leave`, `payroll`, `notification`, `messaging`, `audit`, `platform` (`packages/db/prisma/schema.prisma`); isolation by RLS (ADR-005) and per-role grants.

**Alternatives considered** — a database per module: rejected — cross-module consistency needs sagas, and backups multiply; one schema: rejected — module ownership of tables disappears.

**Consequences** — one backup, one PITR, transactional consistency across modules. Grants per schema become the boundary for the auth split (ADR-017). The plan named a managed PostgreSQL; the stack runs `postgres:18-alpine` in Compose (`DV-09`).

**Plan impact** — none.

## ADR-003 — pg-boss and a transactional outbox instead of a broker

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted; extended by ADR-019 |
| **Task** | P1-10 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §3.2; commit `8ca8565` |

**Context** — `01` specified RabbitMQ quorum queues.

**Decision** — events written to an `outbox` table in the same transaction as the change, pumped to pg-boss, handled by idempotent typed consumers in the worker; the correlation id travels in the envelope.

**Alternatives considered** — RabbitMQ from the start: rejected — another system to keep alive at a volume far below pg-boss's limits (N7).

**Consequences** — no lost events when a transaction commits; no extra infrastructure. Throughput at peak unmeasured (N7).

**Plan impact** — none.

## ADR-004 — Module boundaries enforced by lint

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P1-12 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §3, §6 Phase 1 DoD; `eslint.config.js` |

**Decision** — `eslint-plugin-boundaries` refuses any cross-module import other than through the module's `index.ts`; `no-restricted-imports` bars domain code from Prisma; the frontend is barred from server packages (`frontend-boundary.test.ts`, ADR-017).

**Alternatives considered** — convention and review only: rejected — N1 names this as the risk most likely to dissolve silently.

**Consequences** — the boundaries are machine-checked — **locally**, because there is no CI (`P0-09`).

**Plan impact** — none.

## ADR-005 — Tenant isolation by forced, fail-closed row-level security

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P1-01 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/06`, `docs/PLAN/12` §3; migration `20260818033000_rls_and_guards` |

**Decision** — RLS enabled **and forced** on every table with `tenant_id`; the policy reads `app_current_tenant()`, which returns nothing without a context, so a forgotten context reads zero rows; runtime roles are `NOBYPASSRLS` and never own tables, re-asserted on every deploy; context is set per transaction by `withTenant()` with a bound parameter; `LISTEN`/`NOTIFY` channels per tenant; composite tenant foreign keys where tenant data references tenant data, because foreign keys are checked without RLS (commit `61f2291`).

**Alternatives considered** — application-level `WHERE tenant_id = …`: rejected — one forgotten clause is a cross-tenant leak with no error; a database per tenant: rejected — operational cost at SME prices.

**Consequences** — isolation survives handler bugs. Not a defence against cross-object access **within** a tenant (`SECURITY/02` §1(c)).

**Plan impact** — none.

## ADR-006 — Additive-only migrations, and a runner for what cannot run in a transaction

| | |
|---|---|
| **Date** | 2026-08-18; runner 2026-09-01 |
| **Status** | Accepted |
| **Task** | P1-03 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/09`; commit `323fab8` |

**Decision** — migrations never drop, rename, or truncate (P12), enforced by `ops/scripts/lint-migrations.mjs`; each sets `lock_timeout`. Statements that cannot run inside a transaction — chiefly `CREATE INDEX CONCURRENTLY` on hot tables — live in `migrations-online/`, must be re-runnable, and must need to be there (a test refuses a file without `CONCURRENTLY`).

**Alternatives considered** — Prisma's migration runner alone: rejected — Prisma 7 wraps every migration in a transaction and `CONCURRENTLY` fails there (SQLSTATE 25001); a `-- prisma-no-transaction` marker borrowed from other tools: inert in Prisma, found and rejected (commit `323fab8`).

**Consequences** — the previous image runs against the new schema, so rollback is redeploying. Dead columns accumulate (R32).

**Plan impact** — none.

## ADR-007 — The control plane is a separate realm with no path to tenant data

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P1-11 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/00` §3.2 P11, `docs/PLAN/12` Phase 1 |

**Decision** — superusers authenticate to audience `hrms-admin` with a separate key realm, 8-hour sessions, and mandatory TOTP enforced by a `CHECK` constraint; the control plane connects as `hrms_platform`, which has no grant on `auth.users`, `iam.*`, `audit.*`, or module schemas; its actions go to `platform.platform_audit_logs`.

**Alternatives considered** — an admin role inside the tenant plane: rejected — R20/R21, the superuser holding credentials to tenant data.

**Consequences** — a leaked superuser account cannot read employees. Support cannot "just look" at a tenant's data — by design. TOTP secrets were stored in plaintext and superuser logins are not audited (`P6-14`).

**Plan impact** — none.

## ADR-008 — One Next.js application serving pages and the API; the frontend API-only

| | |
|---|---|
| **Date** | 2026-08-18; enforced 2026-08-31 |
| **Status** | Accepted |
| **Task** | P1-09, PS-13 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §3.2, `docs/PLAN/14` §10.8; commit `99924e0` |

**Decision** — `apps/web` holds every page and every route handler. Every page is a client component calling `api()`; no page imports server packages, route handlers, or the manifest — enforced by `frontend-boundary.test.ts`. Next.js **16** is installed where the plan named 15 (`DV-13`).

**Alternatives considered** — a separate frontend and backend from the start: rejected at the time as two deployables for no gain; now possible as stage 8 (`PS-11`) because the frontend is already API-only.

**Consequences** — one build; stage 8 is a build change, not a refactor. The boundary test was inert when first written — see ADR-020.

**Plan impact** — none.

## ADR-009 — A PWA, not a native app, for employees

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-03 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/11` §1, §2.4 |

**Decision** — the employee experience is an installable PWA with a hand-written service worker (ADR-026), an IndexedDB offline punch queue, and Web Push.

**Alternatives considered** — native Android/iOS apps: deferred (`DF-08`) — two more codebases; justified only for limits a tenant cannot accept.

**Consequences** — one codebase. A browser cannot detect mock GPS (R39, R47) or read Wi-Fi SSID; iOS may evict the offline queue (R48) and push is unreliable (R52).

**Plan impact** — none.

## ADR-010 — Attendance evidence is scored and reviewed, never auto-rejected

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-06 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/00` §3.2 P14, `docs/PLAN/10` §5.1 |

**Decision** — every punch is recorded; signals (distance, accuracy, photo, consent, clock skew, device type, office network) add flags with plain-language messages and a trust score; flagged punches go to an HR review queue. Browser punches carry a permanent `WEB_UNVERIFIED_DEVICE` penalty; the office network removes it but never scores above baseline.

**Alternatives considered** — accept or reject automatically on thresholds: rejected — indoor GPS and denied permissions would reject honest employees (R43), and a spoof-proof claim is false (R39).

**Consequences** — HR carries a review load (the 12% threshold, uncalibrated — `P3-17`). A signal that can be forged without detection undermines the queue: the office network could be (`P3-12`).

**Plan impact** — none.

## ADR-011 — Real time over SSE and `LISTEN`/`NOTIFY`

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-09 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §3.2, `docs/PLAN/13` §2.3; commit `caf74c1` |

**Decision** — the live dashboard streams server-sent events fed by PostgreSQL `LISTEN`/`NOTIFY`, **one channel per tenant** (notifications sit outside RLS), 32 streams per process, then 20-second polling stated on screen. Fetch-based rather than `EventSource`, so the bearer header can be sent. Verified through a real nginx under three buffering configurations.

**Alternatives considered** — Socket.IO with Redis (`01`): rejected — cross-node fan-out not needed for one web process.

**Consequences** — no extra infrastructure. Each stream holds a connection; horizontal scale needs a different fan-out.

**Plan impact** — none (`DV-05`).

## ADR-012 — Tenant and site time zones

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-10 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/13` §2.1; commit `7c3f2d0` |

**Context** — no plan mentioned time zones. Day boundaries in UTC filed every punch between 06:00 and 10:59 WIB on the previous day: every day absent, nobody late, every deduction wrong — with no error.

**Decision** — `tenant.tenants.timezone` (IANA, default `Asia/Jakarta`); every working-day boundary computed in the tenant's zone; a backfill job for punches written before the fix (`P3-13`).

**Alternatives considered** — a fixed UTC+7 offset: rejected — wrong for WITA and WIT, and wrong for the backfill once tenants differ.

**Consequences** — correct dates. Times displayed in the browser use the device's zone, which can disagree for HR viewing another zone (`PF-12`).

**Plan impact** — an addition; `docs/PLAN/02` and `10` not amended.

## ADR-013 — Generic attendance machine import, not per-vendor connectors

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-02 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` Phase 3, `docs/PLAN/13` §2.6 |

**Decision** — column recognition with aliases, proven against ZKTeco, an Indonesian date format, and an export without a status column. Without a punch type, the first punch of a day is a clock-in and the rest clock-outs.

**Alternatives considered** — connectors per vendor (Solution, Fingerspot, ZKTeco, Hikvision): deferred (`DF-03`) — about five times the cost. Alternating in/out: rejected — one failed read flips the rest of the day.

**Consequences** — cheap coverage of most machines; no live integration.

**Plan impact** — none (`DV-06`).

## ADR-014 — Leave: single-step approval, and a row lock on the balance

| | |
|---|---|
| **Date** | 2026-08-28; controls fixed 2026-08-31 |
| **Status** | Accepted |
| **Task** | P4-03, P4-05 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/13` §2.4, §5; `packages/core/src/leave/balance.ts`; commits `2fbb7c1`, `ee85b7c` |

**Context** — `12` Phase 4 names a tiered approval flow and an advisory lock per employee.

**Decision** — (a) one approval step; the requester chooses an approver from permission holders, the manager preselected; `leave_approvals` already has `step_order`, so a second step needs no structural migration. (b) Concurrency by `SELECT … FOR UPDATE` on the balance row, with validation after the lock. (c) Self-approval refused without exception; the approver must hold `leave.request.approve`.

**Alternatives considered** — guessing a second-approver rule: rejected — it differs at every company. An advisory lock: not recorded why the row lock was preferred; the row lock gives the same guarantee and is proven by 50 concurrent approvals → exactly one success.

**Consequences** — tiered approval waits for a customer (`DF-01`). The self-approval and approver checks have no automated test (`P4-08`).

**Plan impact** — none (`DV-03`, `DV-04`).

## ADR-015 — The payroll framework was built before Gate C

| | |
|---|---|
| **Date** | 2026-08-28 |
| **Status** | Accepted as a deviation; statutory work remains blocked |
| **Task** | P5-01 – P5-08 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/13` §2.5 |

**Context** — Gate C forbids the first line of payroll before a payroll expert, 30 real payslips, and spike S1.

**Decision** — build only the part that needs no interpretation of regulation: formula parser, components, period-based structures, the run cycle, calculation trace, and `statutory_configs` as the future home of rates. Build **none** of PPh 21, PTKP, BPJS, proration, overtime, or THR calculation. The run screen states the limitation at the top.

**Alternatives considered** — respect the gate literally and build nothing: the build went ahead; the reason for not waiting is not recorded beyond `13` §2.5's separation argument. Build the tax rules from a reading of the regulations: rejected — plausible, wrong numbers are the customer's legal liability.

**Consequences** — statutory components plug in as deductions reading `statutory_configs` without engine changes. Risk N4 ("we have already come too far") is now live: the framework's existence is pressure to build the rest without the gate.

**Plan impact** — none; `TASKS/PHASE-5-PAYROLL.md` blocks every statutory card on Gate C (`DV-02`).

## ADR-016 — Phases 3–6 were built without Gates A and B

| | |
|---|---|
| **Date** | 2026-08-18 to 2026-09-01 |
| **Status** | Accepted as a deviation; gates still to be tested |
| **Task** | — |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/12` §6, `docs/PLAN/13` §1 |

**Context** — Gate A (three pilots import unaided) before Phase 3; Gate B (one paying tenant) before Phase 4. Both "demand real users, not code" (`13` §1).

**Decision** — none recorded. The attendance module is present from the first commit; leave, payroll, and commercialisation followed on 2026-08-28.

**Alternatives considered** — not recorded.

**Consequences** — the product has four modules and no evidence of market pull (risks N5, R26). New work is restricted to hardening, security, usability, and pilot readiness until the gates are tested (`TASKS/README.md`).

**Plan impact** — none (`DV-01`).

## ADR-017 — Split authentication ahead of `docs/PLAN/12` §9's triggers

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Status** | Accepted for stages 1–5 in use and 6–7 built but off; further split stopped by ADR-032 |
| **Task** | PS-01 – PS-07, PS-13 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/14` §1–3, §10; `docs/PLAN/12` §9.1; commits `d7197ad` to `99924e0` |

**Decision** — extract auth in eight stages, the first five valuable whether or not extraction completes: EdDSA with JWKS; enforced access version; Redis rate limits; one authorization decision; `hrms_auth` role; the auth container (opt-in); a broker seam (opt-in); frontend proven API-only.

**Alternatives considered** — wait for §9's triggers: `14` §3 argues auth is a reasonable first split on grounds specific to auth (SSO, a public API) and is candid that none of §9's triggers had fired. Stop after stage 5: recommended by `14` §12 S8 if SSO and a public API are not coming — still open (`OQ-03`).

**Consequences** — stages 1–5 fixed real defects (an inert access version, rate limits multiplied by replicas). The auth container and broker are built and **off**. A shared internal secret, not mTLS (`PS-10`); `hrms_app` still reads `auth.users` (`PS-09`); HS256 still verifies (`PS-08`).

**Plan impact** — `12` §9.1 amended.

## ADR-018 — Rate limiting and caches fail open when Redis is unavailable

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Status** | Accepted |
| **Task** | PS-03 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `packages/cache/src/rate-limit.ts` comments; `docs/PLAN/14` §10.3 |

**Decision** — with Redis unreachable, limits fall back to a local count and the permission cache to direct resolution; the failure is logged once per outage; readiness reports `rateLimit: in-process`. A configured-but-unreachable Redis fails its test suite rather than skipping.

**Alternatives considered** — fail closed: rejected — a cache outage would become a total authentication outage.

**Consequences** — during an outage, limits are per process (weaker, not absent). Per-address limits are separately defeated by `X-Forwarded-For` (`P3-12`).

**Plan impact** — none.

## ADR-019 — NATS JetStream behind a broker seam, off by default

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Status** | Accepted |
| **Task** | PS-07 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/14` §9.1, §10.7; commit `02c25e6` |

**Decision** — the outbox pump publishes through an interface; pg-boss remains the default; NATS JetStream is used when `BROKER_URL` is set. `14` §13.4 narrowed the choice to RabbitMQ or NATS.

**Alternatives considered** — RabbitMQ (`14` §9.1: routing flexibility): not chosen; §9.1 lists NATS JetStream for operational simplicity, and no commit records a further comparison. Kafka: rejected in §9.1 as heavier than the whole application. Replacing pg-boss outright: rejected — the transactional outbox must stay, and nothing requires a broker yet (N7).

**Consequences** — a capability that exists and is not exercised in production; the broker suite skips without a NATS server.

**Plan impact** — none.

## ADR-020 — A guard is not trusted until it has been seen to fail

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Status** | Accepted |
| **Task** | — |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/14` §10.8; `docs/PLAN/13` §4 bug 18; `apps/web/test/frontend-boundary.test.ts`; commit `61f2291` |

**Context** — three controls looked right and were not. `frontend-boundary.test.ts` was written with patterns built from `new RegExp` and template literals; the escapes were lost when written to disk, the pattern became `froms+`, and the test passed while matching nothing. The route manifest coverage check discovered handlers only in `export const GET =` form, so a handler written as `export function GET()` skipped registration and every permission check while working perfectly by hand (`docs/PLAN/13` §4, bug 18). A single-column foreign key on `employee_documents` looked correct until a deliberate cross-tenant insert succeeded.

**Decision** — every structural check — lint rule, coverage test, boundary test, constraint — is run once against a deliberate violation before it is committed, and the violation used is recorded.

**Alternatives considered** — trusting a green suite: this is what failed.

**Consequences** — a small cost per guard. `TASKS/00-TASK-CONVENTIONS.md` §4 item 4 makes it part of the global DoD.

**Plan impact** — `docs/PLAN/16` §1 rule 4.

## ADR-021 — Tests use real services, never mocked data layers

| | |
|---|---|
| **Date** | 2026-08-18; restated by the user during the build |
| **Status** | Accepted |
| **Task** | — |
| **Deciders** | The user (instruction: use real database access; where impossible, skip, mark, and record in `docs/PLAN/13`) |
| **Reconstructed** | Yes — `docs/PLAN/16` §1, `docs/PLAN/13` §5 "Tests that skip rather than fail" |

**Decision** — tests touching data run against real PostgreSQL, Redis, and NATS; setup as owner, assertions through `withTenant`; fresh random tenants; an absent optional service skips with a message, a configured-but-broken one fails.

**Alternatives considered** — mocks and fakes: rejected — a fake proves only that it agrees with the assertion; RLS, `effectiveTo: null`, and Lua atomicity cannot be shown by one.

**Consequences** — tests need `pnpm db:up`; suites run serially. No `vi.mock` exists in the suite.

**Plan impact** — none.

## ADR-022 — `PLAN/` moved under `docs/PLAN/`; numbers kept; new documents from 15

| | |
|---|---|
| **Date** | 2026-09-13 |
| **Status** | Accepted |
| **Task** | — |
| **Deciders** | The user (request to mirror `zed378/zed-auth`'s `docs/` structure) |
| **Reconstructed** | No |

**Context** — the user asked for a `docs/` directory like `zed-auth`'s, adapted to this codebase. `zed-auth` numbers plan documents by topic (`05-API-CONTRACT`, …). This repository's `PLAN/00`–`14` already existed and code comments cite them as `PLAN/NN §x`.

**Decision** — `git mv PLAN docs/PLAN`; every `PLAN/` reference rewritten to `docs/PLAN/` by a script that is idempotent and deepens outbound relative links; existing numbers kept; topics `zed-auth` has and this plan lacked added as `15`–`23`; `docs/README.md` maps `zed-auth` topics to numbers here.

**Alternatives considered** — renumber to match `zed-auth`: rejected — every `PLAN/NN` citation in code would silently point at the wrong document. Leave `PLAN/` at the root: rejected — the request was for `docs/`.

**Consequences** — one commit (`f3d19ba`, 145 files) touching comments across the code; verified by reversing the substitution and comparing (84 files identical, 48 differing only in line endings, 0 real differences).

**Plan impact** — `docs/README.md`.

## ADR-023 — Documentation in English, interface in Indonesian

| | |
|---|---|
| **Date** | 2026-08-31 |
| **Status** | **Superseded by ADR-030** (2026-09-14) |
| **Task** | — |
| **Deciders** | The user (instruction: documentation, comments, and README in English) |
| **Reconstructed** | Partly — the instruction was given during the build; the scope question arose on 2026-09-13 |

**Decision** — plan documents, code comments, README, and these folders in English; the product interface in Indonesian (`lang="id"`, seeded menus, emails, push).

**Open** — whether API `message` strings, which users read, are "interface" (Indonesian) or "code" (English). Commits `a13cfca` and `5d99226` translated many to English. Until decided, nothing is translated further.

**Consequences** — a user can currently see an English error on an Indonesian page.

**Plan impact** — `docs/UI-UX/13` §1.

## ADR-024 — Email through Resend, printed to the log when unconfigured

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P6-05 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `packages/core/src/notification/transport.ts` comments |

**Decision** — without `RESEND_API_KEY` and `EMAIL_FROM`, the transport prints emails to the log; with them, it sends through Resend. Delivery is recorded before sending so a crash cannot double-send.

**Alternatives considered** — own SMTP: rejected — IP reputation, SPF, DKIM, and DMARC to manage.

**Consequences** — development needs no email account. A production deployment missing the variables silently sends nothing: invitations and password resets never arrive (`docs/PLAN/20` §4).

**Plan impact** — none.

## ADR-025 — Attendance photos uploaded through the server

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-05 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `apps/web/src/app/api/attendance/photo/route.ts` |

**Decision** — photos (≤ 512 KB, compressed on the device) are posted to the server, which strips EXIF before storing.

**Alternatives considered** — presigned URLs direct to object storage (`docs/PLAN/10` §4.1): rejected — the file would reach storage as the device sent it, GPS coordinates included; the server is the only place EXIF removal can be guaranteed.

**Consequences** — upload traffic passes through `web`; negligible at this size.

**Plan impact** — none (`DV-11`).

## ADR-026 — A hand-written service worker

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P3-03 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `apps/web/public/sw.js` header |

**Decision** — `sw.js` written by hand; sensitive data and tokens never enter Cache Storage; everything cleared on logout; verified by `service-worker.test.ts` in a VM.

**Alternatives considered** — Workbox (`12` Phase 3): rejected — for one app shell and one queue, an abstraction that must be understood before debugging why a request was cached.

**Consequences** — small and auditable; every caching rule is explicit.

**Plan impact** — none (`DV-12`).

## ADR-027 — Files on local disk behind a `BlobStore` interface

| | |
|---|---|
| **Date** | 2026-08-18 |
| **Status** | Accepted |
| **Task** | P2-04, P3-05, P4-13 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `packages/core/src/storage/blob-store.ts` |

**Decision** — photos, documents, and leave attachments are written to directories (`PHOTO_STORAGE_DIR`, `DOCUMENT_STORAGE_DIR`, `LEAVE_ATTACHMENT_STORAGE_DIR`) through one interface, so an S3-compatible store later touches a single file.

**Alternatives considered** — managed S3-compatible storage (`12` §3.2): not yet; reason not recorded beyond the interface comment.

**Consequences** — files live on the host volume and are backed up by `backup.sh`'s storage archive — on the same host (risk F4).

**Plan impact** — none (`DV-14`).

## ADR-028 — Metrics: `404` without the token, never labelled by tenant

| | |
|---|---|
| **Date** | 2026-09-01 |
| **Status** | Accepted |
| **Task** | P6-22 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `docs/PLAN/13` §5 Observability; commit `0a6e696` |

**Decision** — `/api/metrics` answers `404` unless `METRICS_TOKEN` is set, and `404` for a wrong token; labels are route and status only; a test asserts no UUID-shaped string in the output.

**Alternatives considered** — `401` for a wrong token: rejected — confirms something is there. Tenant labels: rejected — a time-series store outlives every access control, and a tenant label publishes the customer list.

**Consequences** — per-tenant figures live on permissioned dashboards, not in Prometheus.

**Plan impact** — `12` §11 lists metrics of the forbidden kind; not amended.

## ADR-029 — An unconfigured office network degrades `FALLBACK_ONLY`; suspension does not revoke live sessions

| | |
|---|---|
| **Date** | 2026-08-28 / 2026-08-31 |
| **Status** | Accepted |
| **Task** | P3-11, P6-08 |
| **Deciders** | Not recorded |
| **Reconstructed** | Yes — `packages/core/src/attendance/punch.ts`, migration `20260901090000_work_site_networks`, `packages/core/src/platform/tenant-admin.ts` |

**Decision** — two deliberate fail-open choices: (a) a tenant with no office ranges configured behaves as `ALLOW_FLAGGED` under `FALLBACK_ONLY`, rather than locking the company out at seven in the morning; the settings screen says so. (b) Suspending a tenant refuses login and refresh but does not force-revoke live access tokens, which expire within 15 minutes.

**Alternatives considered** — (a) fail closed: rejected — the tenant may not know the list exists. (b) revoke on suspension: rejected — forced revocation needs a revocation list read on every request, a cost borne by every tenant that is never suspended (`tenant-admin.ts`).

**Consequences** — (a) a tenant who chose `FALLBACK_ONLY` and forgot the ranges has less than they think — stated on screen. (b) up to 15 minutes of access after suspension (`SECURITY/02` §3(e), accepted).

**Plan impact** — none.

## ADR-030 — Backend in English, frontend fully Indonesian

| | |
|---|---|
| **Date** | 2026-09-14 |
| **Status** | Accepted — supersedes ADR-023 |
| **Task** | P6-24, PF-20 |
| **Deciders** | The user |
| **Reconstructed** | No |

**Context** — ADR-023 left one question open (`OQ-01`): whether API error messages, which pages were displaying to users, are interface text (Indonesian) or system text (English). Two commits from another tool had translated part of them; the root README said not to.

**Decision** — the user: *English for the system — responses, messages, debugging, and everything else; the frontend fully Indonesian.* Therefore:

- API responses, error `message` values, validation messages, logs, and debug output are English.
- The frontend never displays a server `message`. It maps the error `code`, and a finer `reason` where one code covers several user-facing refusals, to Indonesian text in its own catalogue.
- Data the frontend displays from the database — seeded menu labels, leave-type names, holiday names — is frontend content and stays Indonesian. *(Interpretation of the decision, recorded so it can be corrected.)*
- Emails and push notifications, read by users outside the frontend, were asked separately (`OQ-15`) and decided Indonesian — ADR-034.

**Alternatives considered** — (a) Indonesian messages shown as they are: rejected by the user; couples user-facing copy to backend code and mixes languages in logs. (c) English messages shown as they are: rejected — users are Indonesian.

**Consequences** — the error contract gains a `reason` so the frontend can say something specific (`P6-24`, spec required). About 237 Indonesian string literals in about 77 backend files are translated. About 30 frontend places stop rendering `message`, and the frontend's own English strings return to Indonesian (`PF-20`). Tests assert on codes and reasons, which the testing rules already required. Until both tasks land, some pages show English errors — risk F10.

**Plan impact** — `docs/PLAN/15` §6, §11; `docs/UI-UX/00`, `06`, `11`, `13`, `14`; `docs/README.md`; `README.md`; `CLAUDE.md` and `AGENTS.md` rule 12 — all amended 2026-09-14.

## ADR-031 — API documentation behind a superuser session and a hashed docs key

| | |
|---|---|
| **Date** | 2026-09-14 |
| **Status** | Accepted |
| **Task** | P6-18.3 |
| **Deciders** | The user (accepted the recommendation in `OQ-11`) |
| **Reconstructed** | No |

**Context** — the user asked for Swagger-style API documentation reachable only by an administrator, with an additional header carrying a secret they set, stored encrypted in the database.

**Decision** — one platform-wide secret generated by `ops/scripts/set-docs-key.mjs`, shown once, stored as an **Argon2id hash** in `platform.api_docs_keys`, two valid during rotation. Both the interactive page and the OpenAPI JSON move to the control plane and require a **platform superuser session and** the `X-Docs-Key` header; a wrong or missing key answers `404`. The key is typed into the page and held in memory only. The tenant route `GET /api/openapi.json` is removed. Spec: `MEMORY/specs/P6-18-api-documentation-access.md`.

**Alternatives considered** — reversible encryption with the PII key ring, as first asked: rejected in favour of hashing, because the secret only needs verifying and a hash cannot be recovered even with the application's keys. A per-tenant secret for tenant administrators: rejected — "a secret only I know" is a single operator's secret. A settings screen for the secret: rejected — another surface to protect. Exchanging the key for a cookie: rejected — one more credential.

**Consequences** — tenant administrators lose access to the OpenAPI JSON they had. The operator must keep the secret somewhere safe; a lost secret is replaced by running the script again. The page must load under the CSP from `P6-12`.

**Plan impact** — `docs/PLAN/15` §10, `docs/PLAN/17` §8 amended 2026-09-14.

## ADR-032 — Authorization stays in-process; the service split stops

| | |
|---|---|
| **Date** | 2026-09-14 |
| **Status** | Accepted |
| **Task** | PS-10, PS-11, PS-12 |
| **Deciders** | The user |
| **Reconstructed** | No |

**Context** — ADR-017 built stages 1–7 of `docs/PLAN/14`, whose case for splitting auth rested on SSO and a public API arriving (§3). §12 S8 advises stopping after stage 5 if neither is on the roadmap. `OQ-03` asked.

**Decision** — the user: *for now, the gate stays in backend logic for multi-tenant access; SSO may come in the future; there is no public API.* Therefore authorization stays in-process (`decideAccess` inside `apps/web`). Stages 1–5 stay in use. The auth service (stage 6) and the broker (stage 7) stay in the repository, tested, and off — `AUTH_SERVICE_URL` and `BROKER_URL` unset in production. Stage 8 is not pursued. Ed25519 stays; RS256 is reconsidered only if SSO is adopted. One database; the control plane stays in `apps/web`.

**Alternatives considered** — continue to stage 8 and enable the auth service: rejected — the operational cost `docs/PLAN/14` §3 names buys nothing without SSO or external consumers. Delete `apps/auth` and the broker seam: not chosen — they are tested, off by default, cost nothing at runtime, and shorten an SSO project if one comes; revisit if they begin to rot.

**Consequences** — `PS-10`, `PS-11`, `PS-12` wait on `DF-11`. `PS-08` (end HS256) and `PS-09` (revoke `hrms_app` on `auth.users`) stay worthwhile. Risks S3 and S8 move to controlled. `apps/auth` keeps running in the test suite, so it must keep passing — otherwise it should be removed rather than left broken.

**Plan impact** — `docs/PLAN/14` §13 annotated with the decision; `docs/PLAN/15` §8, `docs/PLAN/17` §9, `docs/PLAN/22`, `docs/SECURITY/02` §10 amended 2026-09-14.

## ADR-033 — First-year capacity envelope: 3 tenants, up to 600 employees

| | |
|---|---|
| **Date** | 2026-09-14 |
| **Status** | Accepted — revisit at the first tenant beyond it |
| **Task** | P6-21, P0-11 |
| **Deciders** | The user |
| **Reconstructed** | No |

**Context** — `docs/PLAN/18` §5 recorded that no capacity assumption existed anywhere, so no host could be sized and no load test designed (`OQ-05`). The question was first asked in terms the user did not follow, then again as three plain questions.

**Decision** — the user: *about 3 companies in the first year, with fewer than 200 monitored employees.* The envelope is sized for the looser reading of "fewer than 200" — per company rather than in total: **3 tenants, ≤ 600 employees, ≤ 600 morning punches assumed within 15 minutes.** Load tests run at 3×: 1,800 punches with photos in 15 minutes plus 100 simultaneous offline replays.

**Alternatives considered** — size for the plan's implicit 5–50 tenants (`12` §10.3 N2): rejected — an order of magnitude beyond what the business expects, and it would pull capacity work ahead of security and usability. Size for exactly 200 in total: rejected — if the reading is wrong, the envelope is three times too small; the looser reading costs nothing at this scale.

**Consequences** — one small host is enough; high availability and horizontal scaling are not first-year concerns. `P6-21` loses its question blocker and drops to P3; `P0-11` (a 5,000-row import spike) drops to P3. Risks F9 (controlled), R17 and N7 re-rated. Three tenants is also the pilot count of Gate A — the first year and the gate describe the same customers, so Gate A's pilots are the load.

**Plan impact** — `docs/PLAN/18` §5 and §6, `docs/PLAN/20` §8, `docs/PLAN/22`, `docs/SECURITY/02` §14 amended 2026-09-14.

## ADR-034 — Emails and push notifications in Indonesian

| | |
|---|---|
| **Date** | 2026-09-14 |
| **Status** | Accepted — a scoped exception to ADR-030 |
| **Task** | P6-24 |
| **Deciders** | The user |
| **Reconstructed** | No |

**Context** — ADR-030 made the backend English and the frontend Indonesian. Emails (invitation, password reset, contract and document expiry) and push notifications (leave decisions) are composed by the backend but read by employees and HR outside the frontend. `a13cfca` had translated them to English. `OQ-15` asked.

**Decision** — the user: *emails and notifications in Indonesian.* Any content the backend composes for a person to read outside the frontend — email, Web Push, and WhatsApp when it exists — is Indonesian. Logs and metadata about sending them stay English.

**Alternatives considered** — English, consistent with the rest of the backend: rejected — the reader is the same Indonesian user the frontend serves, and an English password-reset email reads like phishing.

**Consequences** — the templates in `packages/core/src/notification/templates.ts` and the push text in `apps/worker/src/leave-notify.ts` return to Indonesian in `P6-24`, which also adds a test pinning them so a future translation pass cannot switch them silently. The backend "no Indonesian literals" test allowlists these files.

**Plan impact** — `docs/PLAN/15` §11, `docs/UI-UX/08` §8 and `13` §1, `docs/README.md`, `README.md`, `CLAUDE.md` and `AGENTS.md` rule 12 amended 2026-09-14.

---

## ADR-035 — Permission ceiling: nobody but the owner confers what they do not hold

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Status** | Accepted — amends `docs/PLAN/05` §9 |
| **Task** | P6-13 |
| **Deciders** | Agent, under the task's DoD; open to the user's review |
| **Reconstructed** | No |

**Context** — `docs/PLAN/05` §9 planned an `iam.grant.any` permission gating grants beyond one's own. It was never built: any holder of `iam.role.manage` or `iam.grant.manage` could confer anything, including on themselves, and could DENY the owner's own IAM permissions or empty the `TENANT_OWNER` role (risk F12, `docs/SECURITY/02` §5(a)). The abuse-case test demonstrated the lockout: after a delegate emptied the owner role, the owner's next IAM request was refused.

**Decision** — `assertCanConfer` in `packages/core/src/iam/ceiling.ts`, called by every function that confers access:
1. A holder of the `TENANT_OWNER` role is exempt.
2. Anyone else may confer only permissions they hold — roles plus unexpired GRANTs minus DENYs, **before** the subscription filter. Conferring is: permissions added to a role, a GRANT, lifting a DENY, and assigning a role by invitation.
3. Removing access is never capped: DENY, removing a GRANT, removing permissions from a role.
4. Anyone else may not change the `TENANT_OWNER` role, assign it, or set or remove a grant on an owner.
5. Refusal: 403 `PERMISSION_CEILING`, `details.permissions` or `details.role`.

**Alternatives considered** — an `iam.grant.any` permission as planned: rejected — it is one more permission that itself needs a ceiling, and the owner already holds everything. Comparing against effective (subscription-filtered) permissions: rejected — a delegate could not invite employees into the standard `EMPLOYEE` role while payroll is unsubscribed, because it carries `payroll.payslip.read.own`. Refusing self-grants outright (card step 3): not done — with the ceiling, a self-grant can only confer what one already holds, so the rule would close nothing.

**Consequences** — a tenant that already delegated IAM to a custom role loses the ability, through that role, to confer permissions it does not hold; the owner still can. `ErrorCode.PERMISSION_CEILING` needs Indonesian text (`PF-20`). The IAM routes now share one `IamError` mapping, which also fixes conflicts surfacing as 404 on the role and grant routes.

**Plan impact** — `docs/PLAN/05` §9 amended; `docs/SECURITY/02` §5 and risk F12 updated.

---

## Decisions Pending

Each moves into the log when decided. The open question holds the detail and a recommendation. Answered on 2026-09-14: `OQ-01` → ADR-030, `OQ-11` → ADR-031, `OQ-03` → ADR-032 (making `OQ-04` and `OQ-10` unnecessary), `OQ-05` → ADR-033, `OQ-15` → ADR-034.

| Question | Decision needed | Blocks |
|---|---|---|
| `OQ-02` | Off-host backup destination; PII key holders | `P6-17` |
| `OQ-06` | Alert recipient and security owner | `P6-16` |
| `OQ-07` | Employee document retention period | `P2-10` |
| `OQ-08` | Payroll expert and Gate C timing | Phase 5 statutory work |
| `OQ-09` | Log and error-tracking destination | `P1-16`, `P6-16` |
| `OQ-12` | RPO and RTO | `P6-17` |
| `OQ-13` | Reference-licence subscription credit | `P6-11` |
| `OQ-14` | HS256 retirement date | `PS-08` |
| `P6-24` spec | The shape of `reason` and of validation `details` | `P6-24`, `PF-20` |
| `P3-12` spec | Trusted-hop count versus `X-Real-IP`; what to do with punches already marked `OFFICE_IP_VERIFIED` | `P3-12` |
| `P2-08` spec | Whether unmasking becomes opt-in per request | `P2-08` |
