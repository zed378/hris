# Phase 0 — Foundation and Proof

**Goal** (`docs/PLAN/12` §6): remove the uncertainties that could invalidate the plan before writing production code — four spikes, real artefacts from HR practitioners, and an environment (repository, CI, staging, backups).

**What happened**: the repository was created on 2026-08-18 and production code was written from the first day. The discovery activities and spikes were not recorded as run, and CI and staging were never set up. The build went ahead of this phase's proof work. That is `DV-09` and part of `DV-01` in `BACKLOG.md`.

**Phase 0 DoD** (`docs/PLAN/12` §6):

- [ ] The four spikes pass, or produce a written architectural decision — **S1–S4 not recorded as run**
- [ ] 30 payroll cases documented with expected results — **not collected**
- [x] ADRs for the modular monolith, pg-boss, one multi-schema database, module boundaries — **reconstructed** as ADR-001 to ADR-004 on 2026-09-13
- [ ] Repository, CI, staging, and PITR backups running; a restore tested once — **repository and PITR yes; restore tested; CI and staging no**

---

## Delivered

Retrospective IDs (`00-TASK-CONVENTIONS.md` §1).

| ID | Delivered | Evidence | Status |
|---|---|---|---|
| P0-01 | pnpm + Turborepo monorepo: `apps/web`, `apps/worker`, `apps/auth`; `packages/core`, `db`, `cache`, `contracts`, `observability` | Repository layout; `turbo.json` | DONE (retro) |
| P0-02 | Architecture decisions recorded | ADR-001–004 (reconstructed) | DONE (retro) |
| P0-03 | Local environment: `pnpm db:up` (PostgreSQL 18, Redis), full stack in `ops/docker-compose.yml` | `ops/docker-compose.dev.yml`, `ops/docker-compose.yml` | DONE (retro) |
| P0-04 | Backups: logical dump + storage archive, restore tested at 160 MB | `ops/RUNBOOK.md` §6, test of 28 Aug 2026 | DONE (retro) |
| P0-05 | Point-in-time recovery: WAL archiving, base backup, recovery verified | `ops/RUNBOOK.md` §7 | DONE (retro) |
| P0-06 | `pnpm verify`: migration lint → lint → typecheck, test, build | `package.json` | DONE (retro) |

---

## Open

### P0-07 — Interview five HR practitioners

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | — |
| **Blocked by** | People to interview — outside engineering |
| **Plan refs** | `docs/PLAN/12` §6 Phase 0, `docs/UI-UX/01-USER-PERSONAS.md` |
| **Spec required** | No |
| **Surface** | docs |
| **Size** | M |

**Goal** — a ranked list of pain points from five HR practitioners, preferably users of the reference Excel product, recorded in `MEMORY/records/`.

**Steps**
1. Recruit five practitioners from target-size companies.
2. Ask about their month: attendance reconciliation, leave, payroll preparation. Do not demo.
3. Record pain points ranked by time lost, not features requested.
4. Compare with the personas in `docs/UI-UX/01` and amend them where they are wrong (a deliberate edit).

**Definition of Done**
- Five interview notes (no personal data beyond role and company size) in `MEMORY/records/`.
- A ranked pain-point list.
- `docs/UI-UX/01` confirmed or amended with an ADR if the change is material.

### P0-08 — Collect real artefacts

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Blocked by** | Pilot companies willing to share (`P0-07`) |
| **Plan refs** | `docs/PLAN/12` §6 Phase 0 |
| **Spec required** | No — but the artefacts are personal data |
| **Surface** | docs |
| **Size** | M |

**Goal** — 30 payslips with their inputs, 3 Excel attendance files, 2 fingerprint machine exports, 3 leave policies, held securely and anonymised for use as test fixtures.

**Definition of Done**
- Artefacts stored **outside the repository**, access-controlled; a data processing agreement with each provider.
- Anonymised fixtures derived from them committed under `packages/*/test/fixtures/` — no real names, NIK, NPWP, or bank accounts.
- The machine exports run through `device-format.test.ts`; any format not recognised is a new test.
- The 30 payslips become the golden cases for `P5-11` (Gate C).

### P0-09 — CI pipeline

| | |
|---|---|
| **Status** | TODO |
| **Priority** | **P0** |
| **Depends on** | — |
| **Plan refs** | `docs/PLAN/16` §4, `docs/PLAN/12` Phase 1 DoD (CI gates), `docs/SECURITY/02` §18, risk F2 |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | M |

**Goal** — every push and pull request runs `pnpm verify` against real PostgreSQL and Redis services, plus dependency and secret scanning, and a failure blocks merge.

**Steps**
1. Choose the CI host (the repository is on GitHub; GitHub Actions unless the user says otherwise).
2. Job 1: service containers `postgres:18-alpine` and `redis:8-alpine`; `pnpm install --frozen-lockfile`; `pnpm db:migrate`; `pnpm verify`. Set `REDIS_URL` so Redis suites **fail** rather than skip when Redis is broken (`docs/PLAN/16` §1 rule 5).
3. Job 2: a NATS service; the broker suite.
4. Job 3: `pnpm audit --audit-level high`; a secret scanner over the diff.
5. Job 4: build `ops/Dockerfile.web`, `Dockerfile.worker`, `Dockerfile.auth` (no push yet).
6. Branch protection on `main` requiring jobs 1–4.

**Definition of Done**
- A pull request with a deliberately failing tenant-isolation assertion is **refused** — recorded in the MEMORY record (ADR-020).
- A pull request adding a `route.ts` without a manifest entry is refused.
- A pull request introducing a known-vulnerable dependency is refused.
- All three Dockerfiles build in CI.
- `docs/PLAN/16` §4, `docs/PLAN/17` §9, and risk F2 updated.

**Abuse cases to test** — `SECURITY/02` §18 (vulnerable dependency, committed secret), §19 (guard erosion: a weakened test must still be caught by review, so CI must run the full suite, not a subset).

### P0-10 — Staging environment

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P1 |
| **Depends on** | P0-09 |
| **Blocked by** | A host — outside engineering |
| **Plan refs** | `docs/PLAN/20`, `ops/RUNBOOK.md` |
| **Spec required** | No |
| **Surface** | ops |
| **Size** | L |

**Goal** — a staging deployment from `ops/docker-compose.yml`, with TLS, EdDSA keys, real email, and seeded test tenants — where Gate A pilots and the manual exercises in `docs/SECURITY/05` run.

**Definition of Done**
- Deployed from a tagged commit by a documented procedure.
- `/api/ready` reports `rateLimit: redis` and `signing` not `hybrid`.
- A restore from its own backup rehearsed once.
- No real tenant data.

### P0-11 — Spike S2: Excel import at 5,000 rows

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P3 — no first-year tenant exceeds 200 employees (ADR-033); a 200-row import is covered by the Gate A pilots |
| **Plan refs** | `docs/PLAN/12` §6 spikes, `docs/PLAN/18` §3 |
| **Spec required** | No |
| **Surface** | backend |
| **Size** | S |

**Goal** — measure validation and commit of a 5,000-row employee file; pass is < 60 seconds with per-row errors.

**Definition of Done** — the number, the machine, and the file shape recorded in `MEMORY/records/` and `docs/PLAN/18` §2. If it fails: an ADR for a batched asynchronous import.

### P0-12 — Spike S3: tenant context under 100,000 concurrent transactions

| | |
|---|---|
| **Status** | TODO |
| **Priority** | P2 |
| **Plan refs** | `docs/PLAN/12` §6 spikes, `docs/PLAN/06`, `packages/db/src/tenant-context.ts` |
| **Spec required** | No |
| **Surface** | db |
| **Size** | M |

**Goal** — prove zero cross-tenant reads across 100,000 concurrent `withTenant` transactions on the real connection pool.

**Steps** — many tenants, each transaction reads and asserts every row's `tenant_id` equals its own context, at a concurrency above the pool size, including transactions that throw mid-way.

**Definition of Done** — zero leaks recorded with pool size, concurrency, and duration. A failure is a P0 incident (`docs/SECURITY/04` Playbook 1).

### P0-13 — Spike S1: PPh 21 TER against 30 real payslips

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | `P0-08` (payslips), `OQ-08` (payroll expert) — Gate C |
| **Plan refs** | `docs/PLAN/12` §6 spikes and Gate C, `docs/PLAN/02` (payroll schema) |
| **Spec required** | Yes — money |
| **Surface** | backend |
| **Size** | L |

**Goal** — 30/30 payslips reproduced to the rupiah, as a spreadsheet or script before any application code.

### P0-14 — Spike S4: PWA punching on real devices for 24 hours

| | |
|---|---|
| **Status** | BLOCKED |
| **Blocked by** | A mid-range Android phone and a real iPhone |
| **Plan refs** | `docs/PLAN/12` §6 spikes, `docs/PLAN/11` §2, `docs/UI-UX/09` §6 |
| **Spec required** | No |
| **Surface** | web |
| **Size** | M |

**Goal** — permissions, indoor GPS accuracy, and the IndexedDB queue survive 24 hours on both devices.

**Definition of Done** — results per device recorded; accuracy thresholds or geofence defaults amended by ADR if the numbers demand it. Closes the device items of `P3-15`.
