# AGENTS.md

Instructions for any AI coding agent (Claude Code, Codex, Cursor, Kilo Code, or otherwise) working in this repository. Follows the [agents.md](https://agents.md) convention and must stay consistent with [`CLAUDE.md`](CLAUDE.md) — **if you update one, update the other.**

## Project Summary

**HRMS** is a multi-tenant HR management suite for Indonesian SMEs — employees, attendance with location and photo evidence, leave, and a payroll framework — delivered as a PWA. It is a modular monolith (pnpm + Turborepo): `apps/web` (Next.js 16: pages and every API route), `apps/worker` (background jobs), `apps/auth` (auth service, built but not enabled — authorization stays in-process, ADR-032), domain logic in `packages/core`, one PostgreSQL 18 database with forced row-level security.

The engineering, security, and design reference lives in **`docs/`** ([`docs/README.md`](docs/README.md)). What remains to be done is in **`TASKS/`**; what was done and why is in **`MEMORY/`**. Look things up there rather than re-deriving them.

## Setup Commands

Prerequisites: Node ≥ 24, pnpm 11, Docker.

```bash
cp .env.example .env              # development values pre-filled
pnpm install
pnpm db:up                        # PostgreSQL 18 (port 5433) and Redis
pnpm db:migrate                   # Prisma migrations, then online migrations
pnpm db:seed                      # demo tenant and superuser; prints the TOTP secret

pnpm --filter @hrms/web dev       # web and API on :3000
pnpm --filter @hrms/worker dev    # outbox pump and jobs
```

Demo tenant: `demo` / `owner@demo.test` / `DemoPassword123`. Demo superuser: `admin@hrms.test` / `AdminPassword123` with TOTP (`pnpm dev:totp <secret>`).

NATS for the broker tests: `docker run -d --name hrms-nats -p 4222:4222 nats:alpine -js`.

## Build and Test Commands

```bash
pnpm verify                              # lint:migrations → lint → typecheck, test, build
pnpm lint:migrations                     # refuses destructive migrations
pnpm lint                                # includes module boundary rules
pnpm --filter @hrms/core test            # one package
pnpm --filter @hrms/web test             # gateway, manifest, menu, boundary, service worker
pnpm --filter @hrms/auth-service test    # auth service over real HTTP
pnpm --filter @hrms/db test              # tenant isolation, RLS coverage, online migrations
pnpm db:migrate:online                   # CONCURRENTLY migrations only
docker compose -f ops/docker-compose.yml up --build                          # full stack
docker compose -f ops/docker-compose.yml --profile split --profile broker up # split + NATS
```

Do not use `pnpm ci` — that is pnpm's clean-install command. There is **no CI pipeline yet** (`TASKS` `P0-09`); `pnpm verify` runs only when you run it.

## Where to Find the Spec for Any Task

| Task area | Document |
|---|---|
| What to do next | `TASKS/PROGRESS.md` → the phase file's task card |
| Principles P1–P16 | `docs/PLAN/00` §3.2 |
| Architecture as built, phases, gates | `docs/PLAN/12` |
| Implementation status, silent bugs found | `docs/PLAN/13` |
| Auth service, tokens, Redis, broker | `docs/PLAN/14` (the split stops at stage 5 in use — ADR-032) |
| Data model | `docs/PLAN/02`; `packages/db/prisma/schema.prisma` |
| Permissions and menus | `docs/PLAN/05` |
| Multitenancy and authentication | `docs/PLAN/06` |
| Migrations | `docs/PLAN/09` |
| Attendance evidence | `docs/PLAN/10` |
| PWA and offline | `docs/PLAN/11` |
| API contract, error codes | `docs/PLAN/15` |
| Testing rules | `docs/PLAN/16` |
| Security controls and gaps | `docs/PLAN/17` |
| Performance, observability, deployment | `docs/PLAN/18`, `19`, `20`; `ops/RUNBOOK.md` |
| Acceptance criteria, risks | `docs/PLAN/21`, `22` |
| Feature spec template | `docs/PLAN/23` |
| Threat model | `docs/SECURITY/00`–`05` — **`02` is mandatory for security-sensitive work** |
| Screens | `docs/UI-UX/00`–`14` |
| Open questions, deviations | `TASKS/BACKLOG.md` |
| Past decisions | `MEMORY/DECISIONS.md` |

## Feature Workflow

1. Take a task from `TASKS/PROGRESS.md`; read its *Plan refs*.
2. If *Spec required: Yes*, write `MEMORY/specs/<task-id>-<slug>.md` from `docs/PLAN/23` first.
3. Write abuse-case tests from `docs/SECURITY/02` through the real request path; see them fail.
4. Implement against the task DoD and the global DoD in `TASKS/00-TASK-CONVENTIONS.md` §4.
5. Correct documents the change makes false; add a `MEMORY/` record, index line, changelog entry, and an ADR if needed; update `TASKS/PROGRESS.md`.

## Code Style

- TypeScript throughout; ESLint with `eslint-plugin-boundaries` — cross-module imports only through a module's `index.ts`.
- Domain logic in `packages/core`, framework-free. Route handlers stay thin.
- Request bodies validated with Zod before use. Errors use the envelope and codes in `packages/contracts/src/errors.ts`.
- Raw SQL only through tagged templates (`$queryRaw\`…\``), never string-built.
- `packages/observability` logger only — `no-console` outside tests and scripts.
- Comments explain **why**, at the depth the existing code does. Never claim in a comment a test or guard that does not exist.
- Code, comments, and docs in English; user-facing strings in Indonesian.
- Tailwind utility classes; follow `docs/UI-UX/05` and `06`.

## Hard Rules (Do Not Violate)

1. **Tenant data only through `withTenant()`.** No `BYPASSRLS`, no runtime role owning tables, no new RLS exception without justification in the migration and `rls-coverage.test.ts`.
2. **New `tenant_id` tables**: RLS enabled and forced, a policy, composite tenant foreign keys.
3. **Every route in `ROUTE_MANIFEST`** with module and permission, through the right wrapper. Never mix the tenant and admin guards.
4. **Backend refuses what the frontend hides.** `402` before `403`.
5. **Pages never import server packages**, route handlers, or the manifest.
6. **Migrations are additive.** No `DROP`, `RENAME`, `TRUNCATE`.
7. **History is never overwritten**; audit logs are append-only.
8. **Evidence is scored, never auto-rejected**; no coordinates on team views; only punches are written offline; nothing sensitive cached on the device.
9. **Never log** PII, passwords, tokens, or coordinates; never label metrics by tenant, user, or email.
10. **No statutory payroll work before Gate C; no Phase 7+ module before Gate D.**
11. **No hand-written API reference** — manifest plus `openapi.ts` `DOCS`.
12. **Backend English, frontend Indonesian** (ADR-030). API responses, error and validation messages, logs, and debug output are English. The frontend shows only its own Indonesian text — never a server `message`. Seeded display data stays Indonesian. Emails and push: `OQ-15`, undecided.
13. **No security-sensitive task is done without an abuse-case test seen to fail.**
14. **Never loosen a guard to pass a build.**
15. **`docs/` changes deliberately** — through the deviation protocol, or to correct a current-state statement your change makes false.
16. **Tests use real services — no mocked data layers.** If a real-service test is impossible, skip it, mark it, and record why in `docs/PLAN/13`.
17. **Stage commits by explicit path — never `git add -A` or `git add .`** Check `git status` and `git log` for other agents' changes and leave them out. One agent per working tree.

## PR and Change Instructions

- Branch: `feat|fix|chore/<task-id>-<slug>`. Commit subject: `<task-id>: <what>`.
- The body states: the task ID, the plan sections implemented, the tests added and whether each was seen to fail, whether `pnpm verify` ran (locally or in CI), and any deviation with its ADR.
- One task per PR where possible. Include the `MEMORY/` record and `TASKS/` updates in the same PR.
- A change touching `packages/db/prisma/migrations`, `route-manifest.ts`, `eslint.config.js`, `define-*route.ts`, `packages/core/src/auth`, `packages/core/src/iam`, or any test assertion's strictness needs explicit review.

## When Uncertain

Check `docs/`, `TASKS/BACKLOG.md`, `MEMORY/DECISIONS.md`, and the code comments. If the answer is not there, add an open question to `TASKS/BACKLOG.md` with a recommendation and ask — do not invent an architectural decision. Never report something as verified that was not.
